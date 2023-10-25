import { GetParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns" 
import { Handler } from "aws-lambda"
import axios from "axios"
import _ from "lodash"

const ssmClient = new SSMClient()
const ssmKeyId = process.env.SSM_KEY_ID!
const snsClient = new SNSClient()

const ssmVariableNames = [
    "/GoCardless/Access-Token",
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
        Name: "/GoCardless/Requisition-id",
        Value: accessToken,
        Type: "SecureString",
        KeyId: ssmKeyId,
        Overwrite: true
    }))

    console.log("Updated requisition ID SSM param")

    const publishCommand = new PublishCommand({
        TopicArn: requisitionTopicARN,
        Message: `Please click the following link to authorize ingest-shared-expenses on AWS to read your bank account transactions, in order to export these to google sheets\n\n${requisitionResponse.data.link}`,
        Subject: "A GoCardless Bank Account Data requisition requests requires your approval"
    })
    const publishResponse = await snsClient.send(publishCommand)
    console.log("Published message to SNS topic")

    return {
        requisitionId: requisitionResponse.data.id
    }
}