import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm"
import { Handler } from "aws-lambda"
import axios from "axios"
import _ from "lodash"

const ssmClient = new SSMClient()

const ssmVariableNames = [
    "/GoCardless/Access-Token",
    "/GoCardless/Institutions-API-Endpoint",
    "/GoCardless/Country",
    "/GoCardless/Bank-Name"
]
const ssmParametersCommand = new GetParametersCommand({
    Names: ssmVariableNames,
    WithDecryption: true
})


export const handler: Handler = async () => {
    const ssmResponse = await ssmClient.send(ssmParametersCommand)
    const accessToken = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Access-Token" })!.Value!
    const institutionsEndpoint = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Institutions-API-Endpoint" })!.Value!
    const country = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Country" })!.Value!
    const bankName = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Bank-Name" })!.Value!

    const response = await axios.get(institutionsEndpoint, { params: { "country": country }, headers: { "Accept": "application/json", "Authorization": `Bearer ${accessToken}` } })

    console.log(`Received ${response.status} response from access token endpoint`)

    const institutionId = response.data.filter((institution: { name: string }) => institution.name == bankName)[0].id

    return {
        institutionId
    }
}