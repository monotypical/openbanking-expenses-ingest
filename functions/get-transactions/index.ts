import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import { Handler } from "aws-lambda"
import { randomUUID } from "crypto"
import NordigenClient from "nordigen-node"
import type { Requisition } from "../../lib/types"
import { z } from "zod"
import { format } from "date-fns"

type UploadTransactionsInput = {
    Requisition: string
    AccessToken: string
    DateFrom: string
    DateTo: string
    Country: string
    Currency: string
    AccountUsersKey: string
    AccountUsersBucket: string
}

type UploadTransactionsOutput = {
    RawTransactionsObjectKey: string
    FormattedTransactionsObjectKey: string
}

const AccountUser = z.object({
    DebtorName: z.string(),
    Reference: z.string(),
    ExportName: z.string(),
})
type AccountUser = z.infer<typeof AccountUser>

const RequisitionResponse = z.object({
    accounts: z.array(z.string()).nonempty(),
})
type RequisitionResponse = z.infer<typeof RequisitionResponse>

const ApiTransaction = z.object({
    transactionAmount: z.object({
        amount: z.coerce.number().finite(),
        currency: z.string().length(3),
    }),
    valueDate: z.coerce.date(),
    debtorName: z.string().optional(),
    creditorName: z.string().optional(),
    remittanceInformationUnstructured: z.string(),
})
type ApiTransaction = z.infer<typeof ApiTransaction>
const ApiTransactionResponse = z.object({
    transactions: z.object({
        booked: z.array(ApiTransaction),
        pending: z.array(ApiTransaction),
    }),
})
type ApiTransactionResponse = z.infer<typeof ApiTransactionResponse>

type TransactionType = "Refund" | "Outgoing Payment" | "Balance Top Up"
type RecognisedCurrencyTransaction = {
    date: string // in ISO-8601 date format
    amount: number
    description: string
    type: TransactionType
}
type UnrecognisedCurrencyTransaction = RecognisedCurrencyTransaction & {
    error: "Unrecognised currency"
}
type Transaction = RecognisedCurrencyTransaction | UnrecognisedCurrencyTransaction

const TRANSACTIONS_BUCKET = process.env.TRANSACTIONS_BUCKET
const REQUISITIONS_TABLE_NAME = process.env.REQUISITIONS_TABLE_NAME
const DATE_FORMAT = "yyyy-MM-dd"

const nordigenClient = new NordigenClient({ secretId: "Not used", secretKey: "Not used" })
const s3Client = new S3Client()
const dynamoDbClient = new DynamoDBClient()

const getAccountId = async (nordigenClient: NordigenClient, requisitonReference: string): Promise<string> => {
    const dynamoResponse = await dynamoDbClient.send(
        new GetItemCommand({
            TableName: REQUISITIONS_TABLE_NAME,
            Key: marshall({ reference: requisitonReference }),
        })
    )
    if (!dynamoResponse.Item) {
        throw new Error(`Requisition reference ${requisitonReference} not found in DynamoDB requisitions table`)
    }
    const dynamoRequisition = unmarshall(dynamoResponse.Item) as Requisition
    if (dynamoRequisition.status !== "Confirmed") {
        throw new Error(`Requisition reference ${requisitonReference} not yet confirmed by user`)
    }

    const requisitionResponse = await nordigenClient.requisition.getRequisitionById(dynamoRequisition.id)
    console.log("Got requisition response from API")
    const requisition = RequisitionResponse.parse(requisitionResponse)

    return requisition.accounts[0]
}

const getAccountUsers = async (bucketName: string, objectKey: string): Promise<AccountUser[]> => {
    try {
        const s3ObjectResponse = await s3Client.send(
            new GetObjectCommand({
                Bucket: bucketName,
                Key: objectKey,
            })
        )
        const accountUsersString = await s3ObjectResponse.Body?.transformToString()
        if (!accountUsersString) {
            throw new Error(`Failed to read account users file ${objectKey} in bucket ${bucketName} from S3`)
        }
        const accountUsersJson = JSON.parse(accountUsersString!)
        return AccountUser.array().parse(accountUsersJson)
    } catch (err) {
        if (err instanceof NoSuchKey) {
            console.error(`Account users file ${objectKey} not found in bucket ${bucketName}`)
        }
        if (err instanceof SyntaxError) {
            console.error(`Account users file ${objectKey} in bucket ${bucketName} invalid JSON`)
        }
        if (err instanceof z.ZodError) {
            console.error(`Failed to parse account users file ${objectKey} in bucket ${bucketName}`)
            console.error(err.format())
        }
        throw err
    }
}

const uploadToS3 = (key: string, object: any) => {
    return s3Client.send(
        new PutObjectCommand({
            Bucket: TRANSACTIONS_BUCKET,
            Key: key,
            Body: JSON.stringify(object),
            ContentType: "application/json",
        })
    )
}

const isTransactionFromAccountUser = (
    transaction: ApiTransaction,
    accountUsers: AccountUser[]
): { isFromAccountUser: boolean; person?: string } => {
    const accountUser = accountUsers.find((accountUser) => {
        return (
            transaction.debtorName === accountUser.DebtorName &&
            transaction.remittanceInformationUnstructured === accountUser.Reference
        )
    })
    return {
        isFromAccountUser: accountUser !== undefined,
        person: accountUser?.ExportName,
    }
}

const formatTransaction = (
    apiTransaction: ApiTransaction,
    accountUsers: AccountUser[],
    currency: string
): Transaction => {
    const { isFromAccountUser, person: accountUser } = isTransactionFromAccountUser(apiTransaction, accountUsers)
    const amount = isFromAccountUser ? apiTransaction.transactionAmount.amount : -apiTransaction.transactionAmount.amount
    const type: TransactionType = isFromAccountUser ? "Balance Top Up" : amount < 0 ? "Refund" : "Outgoing Payment"
    const date = format(apiTransaction.valueDate, DATE_FORMAT)
    const description = isFromAccountUser
        ? accountUser!
        : apiTransaction.creditorName || apiTransaction.remittanceInformationUnstructured
    const error = apiTransaction.transactionAmount.currency === currency ? undefined : "Unrecognised currency"
    return {
        type,
        date,
        amount,
        description,
        error,
    }
}

const formatTransactions = (
    apiTransactions: ApiTransactionResponse,
    accountUsers: AccountUser[],
    currency: string
): Transaction[] => {
    const bookedTransactions: Transaction[] = apiTransactions.transactions.booked.map((apiTransaction) =>
        formatTransaction(apiTransaction, accountUsers, currency)
    )
    const pendingTransactions: Transaction[] = apiTransactions.transactions.pending.map((apiTransaction) =>
        formatTransaction(apiTransaction, accountUsers, currency)
    )
    return [...bookedTransactions, ...pendingTransactions]
}

export const handler: Handler = async (input: UploadTransactionsInput): Promise<UploadTransactionsOutput> => {
    nordigenClient.token = input.AccessToken
    const accountId = await getAccountId(nordigenClient, input.Requisition)
    console.log(`Using account ID ${accountId}`)

    const accountUsers = await getAccountUsers(input.AccountUsersBucket, input.AccountUsersKey)
    console.log("Got account users")

    const account = nordigenClient.account(accountId)
    const transactionResponse = await account.getTransactions({
        dateFrom: input.DateFrom,
        dateTo: input.DateTo,
        country: input.Country,
    })
    console.log("Got transactions from API")

    const uuid = randomUUID()
    const rawTransactionsObjectKey = `accounts/${accountId}/transactions/raw/${uuid}`
    await uploadToS3(rawTransactionsObjectKey, transactionResponse)
    console.log("Uploaded raw transactions to S3")

    const apiTransactions = ApiTransactionResponse.parse(transactionResponse)
    const transactions = formatTransactions(apiTransactions, accountUsers, input.Currency)

    const formattedTransactionsKey = `accounts/${accountId}/transactions/formatted/${uuid}`
    await uploadToS3(formattedTransactionsKey, transactions)
    console.log("Uploaded formatted transactions to S3")

    return {
        RawTransactionsObjectKey: rawTransactionsObjectKey,
        FormattedTransactionsObjectKey: formattedTransactionsKey,
    }
}
