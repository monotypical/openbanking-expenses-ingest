import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import { Handler } from "aws-lambda"
import { randomUUID } from "crypto"
import { getUnixTime } from "date-fns"
import NordigenClient from "nordigen-node"
import type { Requisition } from "../../lib/types"

type UploadTransactionsInput = {
    Requisition: string 
    AccessToken: string
    DateFrom: string
    DateTo: string
    Country: string
}

type UploadTransactionsOutput = {
    S3ObjectKey: string
}

type RequisitionResponse = {
    accounts: string[]
}

// type TransactionResponse = {
//     transactions: {
//         booked: Transaction[],
//         pending?: Transaction[]
//     }
// }

// type Transaction = {
//     transactionAmount: TransactionAmount
// }

// type TransactionAmount = {
//     amount: string
//     currency: string
// }

const TRANSACTIONS_S3_BUCKET = process.env.TRANSACTIONS_S3_BUCKET
const REQUISITIONS_TABLE_NAME = process.env.REQUISITIONS_TABLE_NAME

const nordigenClient = new NordigenClient({ secretId: "Not used", secretKey: "Not used" })
const s3Client = new S3Client()
const dynamoDbClient = new DynamoDBClient()

const validateRequisitionResponse = (o: any): o is RequisitionResponse => {
    return "accounts" in o && typeof o.accounts === "object" && "length" in o.accounts && typeof o.accounts.length === "number"
}

const getAccountId = async (nordigenClient: NordigenClient, requisitonReference: string): Promise<string> => {
    const dynamoResponse = await dynamoDbClient.send(new GetItemCommand({
        TableName: REQUISITIONS_TABLE_NAME,
        Key: marshall({ reference: requisitonReference })
    }))
    if (!dynamoResponse.Item) {
        throw new Error (`Requisition reference ${requisitonReference} not found in DynamoDB requisitions table`)
    }
    const requisition = unmarshall(dynamoResponse.Item) as Requisition
    if (requisition.status !== "Confirmed") {
        throw new Error(`Requisition reference ${requisitonReference} not yet confirmed by user`)
    }

    
    const requisitionResponse = await nordigenClient.requisition.getRequisitionById(requisition.id)
    if (!validateRequisitionResponse(requisitionResponse)) {
        console.log("Unknown response from requisition endpoint:")
        console.log(JSON.stringify(requisitionResponse))
        throw new Error("Unknown response from requisition endpoint")
    }
    if (requisitionResponse.accounts.length < 1) {
        console.log("Account not found in requisition response:")
        console.log(JSON.stringify(requisitionResponse))
        throw new Error("Account not found")
    }
    console.log("Got requisition response from API")

    return requisitionResponse.accounts[0]
}

export const handler: Handler = async (input: UploadTransactionsInput): Promise<UploadTransactionsOutput> => {
    nordigenClient.token = input.AccessToken
    const accountId = await getAccountId(nordigenClient, input.Requisition)
    console.log(`Using account ID ${accountId}`)

    const account = nordigenClient.account(accountId)
    const transactionResponse = await account.getTransactions({ dateFrom: input.DateFrom, dateTo: input.DateTo, country: input.Country })
    console.log("Got transactions from API")

    const transactionsObjectKey = `accounts/${accountId}/transactions/${randomUUID()}`
    await s3Client.send(new PutObjectCommand({
        Bucket: TRANSACTIONS_S3_BUCKET,
        Key: transactionsObjectKey,
        Body: JSON.stringify(transactionResponse),
        ContentType: "application/json"
    }))
    console.log("Uploaded transactions to S3")

    return {
        S3ObjectKey: transactionsObjectKey
    }
}