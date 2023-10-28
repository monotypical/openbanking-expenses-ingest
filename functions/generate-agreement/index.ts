import { GetParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns" 
import { Handler } from "aws-lambda"
import axios from "axios"
import _ from "lodash"
import { addDays, differenceInHours, fromUnixTime, getUnixTime } from "date-fns"
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn"

const REQUISITION_VALIDITY_DAYS = 90

const ssmClient = new SSMClient()
const ssmKeyId = process.env.SSM_KEY_ID!
const snsClient = new SNSClient()
const sfnClient = new SFNClient()

const ssmVariableNames = [
    "/GoCardless/Access-Token",
    "/GoCardless/Requisition-Id",
    "/GoCardless/Requisition-Expires",
    "/GoCardless/Requisition-API-Endpoint",
    "/GoCardless/Requisitions-Topic-ARN",
    "/GoCardless/Requisition-Request-Handler-Endpoint"
]
const ssmParametersCommand = new GetParametersCommand({
    Names: ssmVariableNames,
    WithDecryption: true
})

export const handler: Handler = async (event: {institutionId: string, taskToken: string}) => {
    const ssmResponse = await ssmClient.send(ssmParametersCommand)
    let requisitionId = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Requisition-Id" })!.Value!
    let requisitionExpires = fromUnixTime(Number(_.find(ssmResponse.Parameters, { Name: "/GoCardless/Requisition-Expires" })!.Value!))

    if (differenceInHours(requisitionExpires, new Date()) < 1) {
        console.log("Requesting new requisition")
        const accessToken = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Access-Token" })!.Value!
        const requisitionEndpointURL = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Requisition-API-Endpoint" })!.Value!
        const requisitionTopicARN = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Requisitions-Topic-ARN" })!.Value!
        const requisitionHandlerURL = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Requisition-Request-Handler-Endpoint" })!.Value!

        const redirectUrl = `${requisitionHandlerURL}?taskToken=${encodeURIComponent(event.taskToken)}`

        const requisitionResponse = await axios.post(requisitionEndpointURL,
            { redirect: redirectUrl, institution_id: event.institutionId },
            { headers: { Accept: "application/json", "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` } })
        const requisitionId = requisitionResponse.data.id

        console.log(`Received ${requisitionResponse.status} response from requisition endpoint, id ${requisitionId}`)

        await ssmClient.send(new PutParameterCommand({
            Name: "/GoCardless/Requisition-Id",
            Value: accessToken,
            Type: "SecureString",
            KeyId: ssmKeyId,
            Overwrite: true
        }))

        requisitionExpires = addDays(new Date(), REQUISITION_VALIDITY_DAYS)
        await ssmClient.send(new PutParameterCommand({
            Name: "/GoCardless/Requisition-Expires",
            Value: getUnixTime(requisitionExpires).toString(),
            Type: "String",
            Overwrite: true
        }))

        console.log("Updated SSM params")

        const publishCommand = new PublishCommand({
            TopicArn: requisitionTopicARN,
            Message: `Please click the following link to authorize ingest-shared-expenses on AWS to read your bank account transactions, in order to export these to google sheets\n\n${requisitionResponse.data.link}`,
            Subject: "A GoCardless Bank Account Data requisition requests requires your approval"
        })
        const publishResponse = await snsClient.send(publishCommand)
        console.log("Published message to SNS topic")

    } else {
        console.log("Requisition still valid, re-using")

        const taskSuccessCommand = new SendTaskSuccessCommand({
            taskToken: event.taskToken,
            output: JSON.stringify({
                Payload: {
                    requisitionId: requisitionId,
                    requisitionExpires: requisitionExpires
                }
            })
        })
        await sfnClient.send(taskSuccessCommand)
    }

    return {
        requisitionId: requisitionId,
        expires: requisitionExpires
    }
    
}