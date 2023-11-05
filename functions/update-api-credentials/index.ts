import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { Handler } from "aws-lambda"
import { differenceInHours, differenceInMinutes, fromUnixTime, getUnixTime } from "date-fns"
import NordigenClient from "nordigen-node"
import type { ApiCredential, ExpiringValue, TransactionDetails } from "../../lib/types"

type UpdateApiCredentialsInput = {
    AccessToken: ExpiringValue<string>
    RefreshToken: ExpiringValue<string>
    SecretIdParam: string
    SecretKeyParam: string
}

type UpdateApiCredentialsOutput = {
    AccessToken: ApiCredential
    RefreshToken: ApiCredential,
}

const ssmClient = new SSMClient()

const refreshToken = async (
    nordigenClient: NordigenClient,
    refreshToken: ExpiringValue<string>
): Promise<ApiCredential> => {
    console.log("Refreshing access token")
    const newToken = (await nordigenClient.exchangeToken({
        refreshToken: refreshToken.Value,
    })) as { access: string; access_expires: number }

    const accessTokenExpiresSeconds = newToken.access_expires
    const accessTokenExpiresTimestamp = getUnixTime(new Date()) + accessTokenExpiresSeconds

    return {
        Value: newToken.access,
        Expires: accessTokenExpiresTimestamp,
        Updated: true
    }
}

const getNewTokens = async (nordigenClient: NordigenClient): Promise<UpdateApiCredentialsOutput> => {
    console.log("Requesting new access token")
    const newTokens = (await nordigenClient.generateToken()) as {
        access: string
        access_expires: number
        refresh: string
        refresh_expires: number
    }

    const accessTokenExpiresSeconds = newTokens.access_expires
    const accessTokenExpiresTimestamp = getUnixTime(new Date()) + accessTokenExpiresSeconds
    const refreshTokenExpiresSeconds = newTokens.refresh_expires
    const refreshTokenExpiresTimestamp = getUnixTime(new Date()) + refreshTokenExpiresSeconds

    return {
        AccessToken: {
            Value: newTokens.access,
            Expires: accessTokenExpiresTimestamp,
            Updated: true
        },
        RefreshToken: {
            Value: newTokens.refresh,
            Expires: refreshTokenExpiresTimestamp,
            Updated: true
        }
    }
}

async function getSsmParam<V>(client: SSMClient, paramName: string): Promise<V> {
    const response = await ssmClient.send(
        new GetParameterCommand({
            Name: paramName,
            WithDecryption: true,
        })
    )

    if (response.Parameter === undefined) {
        throw new Error(
            `SSM parameter ${paramName} not retreived. API call returned ${response.$metadata.httpStatusCode}`
        )
    } else {
        return <V>response.Parameter.Value
    }
}

export const handler: Handler = async (input: UpdateApiCredentialsInput): Promise<UpdateApiCredentialsOutput> => {
    const accessTokenValidForHours = differenceInHours(fromUnixTime(+input.AccessToken.Expires), new Date())
    const refreshTokenValidForMinutes = differenceInMinutes(fromUnixTime(+input.RefreshToken.Expires), new Date())

    if (accessTokenValidForHours >= 1) {
        console.log("Access token still valid, not updating or refreshing")
        return {
            AccessToken: { ...input.AccessToken, Updated: false },
            RefreshToken: { ...input.RefreshToken, Updated: false }
        }
    }

    const secretId = await getSsmParam<string>(ssmClient, input.SecretIdParam)
    const secretKey = await getSsmParam<string>(ssmClient, input.SecretKeyParam)
    const nordigenClient = new NordigenClient({
        secretId,
        secretKey,
    })
    nordigenClient.token = input.AccessToken.Value

    if (refreshTokenValidForMinutes >= 1) {
        const newAccessToken = await refreshToken(nordigenClient, input.RefreshToken)
        return {
            AccessToken: newAccessToken,
            RefreshToken: { ...input.RefreshToken, Updated: false }
        }
    } else {
        return getNewTokens(nordigenClient)
    }
}
