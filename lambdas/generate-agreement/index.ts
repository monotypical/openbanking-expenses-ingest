import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { Handler } from "aws-lambda"
import axios from "axios"

const ssmClient = new SSMClient()

export const handler: Handler = async ({ institutionId }: {institutionId: string}) => {
    const accessToken = (await ssmClient.send(new GetParameterCommand({
        Name: "/GoCardless/Access-Token",
        WithDecryption: true
    }))).Parameter!.Value!
    const requisitionEndpointURL = (await ssmClient.send(new GetParameterCommand({
        Name: "/GoCardless/Requisition-API-Endpoint",
        WithDecryption: true
    }))).Parameter!.Value!

    const requisitionResponse = await axios.post(requisitionEndpointURL,
        { redirect: "https://example.com", institution_id: institutionId },
        { headers: { Accept: "application/json", "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}` } })

    console.log(`Received ${requisitionResponse.status} response from requisition endpoint`)

    return {
        requisitionId: requisitionResponse.data.id,
        requisitionLink: requisitionResponse.data.link
    }
}