import { GetParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { Handler } from "aws-lambda"
import _ from "lodash"
import axios from "axios"

const ssmClient = new SSMClient()

const ssmKeyId = process.env.SSM_KEY_ID!

const ssmVariableNames = [
    "/GoCardless/Access-Token-API-Endpoint",
    "/GoCardless/Secret-Id",
    "/GoCardless/Secret-Key",
    "/GoCardless/Access-Token",
    "/GoCardless/Access-Token-Expires",
    "/GoCardless/Refresh-Token",
    "/GoCardless/Refresh-Token-Expires"
]
const ssmParametersCommand = new GetParametersCommand({
    Names: ssmVariableNames,
    WithDecryption: true
})

export const handler: Handler = async () => {
    const ssmResponse = await ssmClient.send(ssmParametersCommand)
    const accessTokenAPIEndpoint = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Access-Token-API-Endpoint"})!.Value!
    const secretId = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Secret-Id"})!.Value!
    const secretKey = _.find(ssmResponse.Parameters, { Name: "/GoCardless/Secret-Key"})!.Value!

    const response = await axios.post(accessTokenAPIEndpoint, {"secret_id": secretId, "secret_key": secretKey}, { headers: { "Accept": "application/json", "Content-Type": "application/json"}})

    console.log(`Received ${response.status} response from access token endpoint`)

    const accessToken: string = response.data.access
    const accessTokenExpiresSeconds: number = response.data.access_expires
    const accessTokenExpiresTimestamp = Math.floor(new Date().getTime() / 1000) + accessTokenExpiresSeconds
    const refreshToken: string = response.data.refresh
    const refreshTokenExpiresSeconds: number = response.data.refresh_expires
    const refreshTokenExpiresTimestamp = Math.floor(new Date().getTime() / 1000) + refreshTokenExpiresSeconds

    await ssmClient.send(new PutParameterCommand({
        Name: "/GoCardless/Access-Token",
        Value: accessToken,
        Type: "SecureString",
        KeyId: ssmKeyId,
        Overwrite: true
    }))
    await ssmClient.send(new PutParameterCommand({
        Name: "/GoCardless/Access-Token-Expires",
        Value: accessTokenExpiresTimestamp.toString(),
        Type: "String",
        Overwrite: true
    }))
    await ssmClient.send(new PutParameterCommand({
        Name: "/GoCardless/Refresh-Token",
        Value: refreshToken,
        Type: "SecureString",
        KeyId: ssmKeyId,
        Overwrite: true
    }))
    await ssmClient.send(new PutParameterCommand({
        Name: "/GoCardless/Refresh-Token-Expires",
        Value: refreshTokenExpiresTimestamp.toString(),
        Type: "String",
        Overwrite: true
    }))

    console.log("Updated SSM Parameters")
    return
}