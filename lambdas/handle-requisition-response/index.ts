import { APIGatewayEvent, Handler } from "aws-lambda"
import { StatusCodes } from "http-status-codes"
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn"

const sfnClient = new SFNClient()

export const handler: Handler = async (event: APIGatewayEvent) => {
    console.log(event)
    if (event.queryStringParameters === null || event.queryStringParameters.taskToken === undefined) {
        return {
            statusCode: StatusCodes.BAD_REQUEST
        }
    }

    const taskSuccessCommand = new SendTaskSuccessCommand({
        taskToken: event.queryStringParameters.taskToken,
        output: JSON.stringify({
            Payload: {
                taskToken: event.queryStringParameters.taskToken
            }
        })
    })
    const taskResponse = await sfnClient.send(taskSuccessCommand)
    console.log(taskResponse)

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: "Requisition authorized"
        })
    }
}