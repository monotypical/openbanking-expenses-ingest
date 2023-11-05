import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import { Handler } from "aws-lambda"
import { randomUUID } from "crypto"
import { stringify } from "csv/sync"
import { format } from "date-fns"
import NordigenClient from "nordigen-node"
import { z } from "zod"
import type { Requisition } from "../../lib/types"

type UploadTransactionsInput = {
    AccessToken: string
    Requisition: string
    TransactionDetails: {
        DateFrom: string
        DateTo: string
    }
    AccountUsers: {
        Bucket: string
        Key: string
    }
}

type UploadTransactionsOutput = {
    RawTransactionsObjectKey: string
    FormattedTransactionsObjectKey: string
    ExpensesCsvObjectKey: string
    TopUpsCsvObjectKey: string
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
type Transaction = {
    date: string // in ISO-8601 date format
    amount: number
    description: string
    type: TransactionType
    error?: string
}

const TRANSACTIONS_BUCKET = process.env.TRANSACTIONS_BUCKET
const REQUISITIONS_TABLE_NAME = process.env.REQUISITIONS_TABLE_NAME
const TRANSACTION_COUNTRY = process.env.TRANSACTION_COUNTRY!
const TRANSACTION_CURRENCY = process.env.TRANSACTION_CURRENCY!
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

const uploadToS3 = (key: string, object: any, type: "JSON" | "CSV") => {
    const body = type === "JSON" ? JSON.stringify(object) : object
    const contentType = type === "JSON" ? "application/json" : "text/csv"
    return s3Client.send(
        new PutObjectCommand({
            Bucket: TRANSACTIONS_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType,
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

const formatApiTransaction = (apiTransaction: ApiTransaction, accountUsers: AccountUser[]): Transaction => {
    const { isFromAccountUser, person: accountUser } = isTransactionFromAccountUser(apiTransaction, accountUsers)
    const amount = isFromAccountUser
        ? apiTransaction.transactionAmount.amount
        : -apiTransaction.transactionAmount.amount
    const type: TransactionType = isFromAccountUser ? "Balance Top Up" : amount < 0 ? "Refund" : "Outgoing Payment"
    const date = format(apiTransaction.valueDate, DATE_FORMAT)
    const description = isFromAccountUser
        ? accountUser!
        : apiTransaction.creditorName || apiTransaction.remittanceInformationUnstructured
    const error =
        apiTransaction.transactionAmount.currency === TRANSACTION_CURRENCY ? undefined : "Unrecognised currency"
    return {
        type,
        date,
        amount,
        description,
        error,
    }
}

const formatTransactionsAsCSVColumns = (transactions: Transaction[]) => {
    return transactions
        .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0))
        .map((t) => {
            const date = new Date(t.date)
            return {
                date: format(date, "dd/MM/yyyy"),
                year: format(date, "yyyy"),
                month: format(date, "MM"),
                description: t.description,
                amount: t.error ? "N/A: unrecognised currency - please confirm" : t.amount,
            }
        })
}

const formatTransactionsAsCSVs = (transactions: Transaction[]): { expensesCSV: string; topUpsCSV: string } => {
    const expensesTransactions = transactions.filter((t) => t.type !== "Balance Top Up")
    const expensesCSV = stringify(formatTransactionsAsCSVColumns(expensesTransactions), {
        columns: [
            { key: "date", header: "Date" },
            { key: "year", header: "Year" },
            { key: "month", header: "Month" },
            { key: "description", header: "Description" },
            { key: "amount", header: "Amount" },
        ],
        header: false,
    })

    const topUpTransactions = transactions.filter((t) => t.type === "Balance Top Up")
    const topUpsCSV = stringify(formatTransactionsAsCSVColumns(topUpTransactions), {
        columns: [
            { key: "date", header: "Date" },
            { key: "year", header: "Year" },
            { key: "month", header: "Month" },
            { key: "description", header: "Person" },
            { key: "amount", header: "Amount" },
        ],
        header: false,
    })

    return { expensesCSV, topUpsCSV }
}

const formatTransactions = (apiTransactions: ApiTransactionResponse, accountUsers: AccountUser[]): Transaction[] => {
    const bookedTransactions: Transaction[] = apiTransactions.transactions.booked.map((apiTransaction) =>
        formatApiTransaction(apiTransaction, accountUsers)
    )
    const pendingTransactions: Transaction[] = apiTransactions.transactions.pending.map((apiTransaction) =>
        formatApiTransaction(apiTransaction, accountUsers)
    )
    return [...bookedTransactions, ...pendingTransactions]
}

export const handler: Handler = async (input: UploadTransactionsInput): Promise<UploadTransactionsOutput> => {
    nordigenClient.token = input.AccessToken
    const accountId = await getAccountId(nordigenClient, input.Requisition)
    console.log(`Using account ID ${accountId}`)

    const accountUsers = await getAccountUsers(input.AccountUsers.Bucket, input.AccountUsers.Key)
    console.log("Got account users")

    const account = nordigenClient.account(accountId)
    const transactionResponse = await account.getTransactions({
        dateFrom: input.TransactionDetails.DateFrom,
        dateTo: input.TransactionDetails.DateTo,
        country: TRANSACTION_COUNTRY,
    })
    console.log("Got transactions from API")

    const uuid = randomUUID()
    const rawTransactionsObjectKey = `accounts/${accountId}/transactions/raw/${uuid}`
    await uploadToS3(rawTransactionsObjectKey, transactionResponse, "JSON")
    console.log("Uploaded raw transactions to S3")

    const apiTransactions = ApiTransactionResponse.parse(transactionResponse)
    const transactions = formatTransactions(apiTransactions, accountUsers)

    const formattedTransactionsKey = `accounts/${accountId}/transactions/formatted/${uuid}`
    await uploadToS3(formattedTransactionsKey, transactions, "JSON")
    console.log("Uploaded formatted transactions to S3")

    const { expensesCSV, topUpsCSV } = formatTransactionsAsCSVs(transactions)
    const expensesCsvKey = `accounts/${accountId}/transactions/csv/expenses/${uuid}`
    await uploadToS3(expensesCsvKey, expensesCSV, "CSV")
    const topUpsCsvKey = `accounts/${accountId}/transactions/csv/top-ups/${uuid}`
    await uploadToS3(topUpsCsvKey, topUpsCSV, "CSV")
    console.log("Uploaded CSVs to S3")

    return {
        RawTransactionsObjectKey: rawTransactionsObjectKey,
        FormattedTransactionsObjectKey: formattedTransactionsKey,
        ExpensesCsvObjectKey: expensesCsvKey,
        TopUpsCsvObjectKey: topUpsCsvKey,
    }
}
