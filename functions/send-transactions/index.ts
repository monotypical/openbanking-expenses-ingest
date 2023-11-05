import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { Handler } from "aws-lambda"
import { SESClient } from "@aws-sdk/client-ses"
import * as sesClientModule from "@aws-sdk/client-ses"
import nodemailer from "nodemailer"

type SendTransactionsInput = {
    Month: string
    ExpensesCsvKey: string
    TopUpsCsvKey: string
    EmailTo: string,
    EmailFrom: string
}

type SendTransactionsOutput = {
    MessageID: string
}

const TRANSACTIONS_BUCKET = process.env.TRANSACTIONS_BUCKET!
const TRANSACTIONS_CONFIG_SET = process.env.TRANSACTIONS_CONFIG_SET!

const s3Client = new S3Client()
const sesClient = new SESClient()
const transporter = nodemailer.createTransport({
    SES: { ses: sesClient, aws: sesClientModule }
})

export const handler: Handler = async (input: SendTransactionsInput): Promise<SendTransactionsOutput> => {
    const expensesCsvResponse = await s3Client.send(
        new GetObjectCommand({
            Bucket: TRANSACTIONS_BUCKET,
            Key: input.ExpensesCsvKey
        })
    )
    const expensesCsv = await expensesCsvResponse.Body!.transformToString()
    const topUpsCsvResponse = await s3Client.send(
        new GetObjectCommand({
            Bucket: TRANSACTIONS_BUCKET,
            Key: input.TopUpsCsvKey
        })
    )
    const topUpsCsv = await topUpsCsvResponse.Body!.transformToString()

    const result = await transporter.sendMail({
        from: input.EmailFrom,
        to: input.EmailTo,
        subject: `Shared Account Files For ${input.Month}`,
        text: `Find attached the expenses and top ups CSV files for the month ${input.Month}`,
        attachments: [
            { filename: `${input.Month}-expenses.csv`, content: expensesCsv, contentType: expensesCsvResponse.ContentType! },
            { filename: `${input.Month}-top-ups.csv`, content: topUpsCsv, contentType: topUpsCsvResponse.ContentType! }
        ],
        headers: {
            "X-SES-CONFIGURATION-SET": TRANSACTIONS_CONFIG_SET
        }
    })
    return {
        MessageID: result.messageId
    }
}
