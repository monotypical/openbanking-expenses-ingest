import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb"
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import { APIGatewayEvent, Handler } from "aws-lambda"
import { StatusCodes } from "http-status-codes"
import { ConfirmationStatus } from "../../lib/types"

type UpdateRequisitionOutput = {
    Requisition: {
        Reference: string
    }
}

const sfnClient = new SFNClient()
const dynamoDbClient = new DynamoDBClient()
const requisitionsTableName = process.env.REQUISITIONS_TABLE_NAME!

export const handler: Handler = async (event: APIGatewayEvent) => {
    if (event.queryStringParameters === null || event.queryStringParameters.ref === undefined) {
        return {
            statusCode: StatusCodes.BAD_REQUEST
        }
    }
    const reference = event.queryStringParameters.ref
    const dynamoKey = marshall({ reference })

    const dynamoRequisitionResponse = await dynamoDbClient.send(new GetItemCommand({
        TableName: requisitionsTableName,
        Key: dynamoKey,
        ProjectionExpression: "taskToken"
    }))
    if (dynamoRequisitionResponse.Item === undefined) {
        return {
            statusCode: StatusCodes.NOT_FOUND,
            message: "Requisition reference not found",
            reference
        }
    }
    const dynamoRequisition = unmarshall(dynamoRequisitionResponse.Item)

    const newStatus: ConfirmationStatus = "Confirmed"
    const dynamoUpdateResponse = await dynamoDbClient.send(new UpdateItemCommand({
        TableName: requisitionsTableName,
        Key: dynamoKey,
        UpdateExpression: "SET #S = :S",
        ExpressionAttributeNames: { "#S": "status", "#R": "reference" },
        ExpressionAttributeValues: marshall({ ":S": newStatus }),
        ConditionExpression: "attribute_exists(#R)",
        ReturnValues: "UPDATED_NEW"
    }))

    if (dynamoUpdateResponse.Attributes?.status?.S === undefined) {
        return {
            statusCode: StatusCodes.NOT_FOUND,
            message: "Requisition reference not found",
            reference
        }
    } else {
        console.log(`Updated requisition reference ${reference} in DynamoDB`)
    }

    const taskOutput: UpdateRequisitionOutput = {
        Requisition: {
            Reference: reference
        }
    }
    const taskSuccessCommand = new SendTaskSuccessCommand({
        taskToken: dynamoRequisition.taskToken,
        output: JSON.stringify(taskOutput)
    })
    try {
        await sfnClient.send(taskSuccessCommand)
        console.log(`Sent taskSuccess to state machine`)
    } catch (e: any) {
        if (e.name === "TaskTimedOut") {
            console.log(`Ignoring duplicate request to complete lambda for reference ${reference}`)
        } else {
            throw e
        }
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: "Requisition authorized",
            reference
        })
    }
}