import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn"
import { Handler } from "aws-lambda"
import { addDays, differenceInHours, fromUnixTime, getUnixTime } from "date-fns"
import NordigenClient from "nordigen-node"
import type { ExpiringValue, Requisition } from "../../lib/types"
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns"
import { randomUUID } from "crypto"

type UpdateRequisitionInput = {
    AccessToken: ExpiringValue<string>
    Requisition: {
        Reference: string
        TableName: string
    }
    Bank: {
        Name: string
        Country: string
    }
    TaskToken: string
    NotificationTopicARN: string
    RequisitionCompleteCallbackURL: string
}

type UpdateRequisitionOutput = {
    Reference: string
    Updated: boolean
}

type Institution = {
    id: string
    name: string
}

type ApiRequisition = {
    id: string
    link: string
    created: string
    institution_id: string
    agreement: string
    user_language: string
}

const dynamoDbClient = new DynamoDBClient()
const sfnClient = new SFNClient()
const snsClient = new SNSClient()

const TRANSACTION_DAYS = 90

const useNewRequisition = async (input: UpdateRequisitionInput): Promise<UpdateRequisitionOutput> => {
    console.log("Requesting new requisition")
    const nordigenClient = new NordigenClient({ secretId: "Not used", secretKey: "Not used" })
    nordigenClient.token = input.AccessToken.Value

    const institutions: Institution[] = await nordigenClient.institution.getInstitutions({
        country: input.Bank.Country,
    })
    const institution = institutions.find((i) => i.name == input.Bank.Name)

    if (institution === undefined) {
        throw new Error(`Failed to find institution ${input.Bank.Name} in country ${input.Bank.Country}`)
    } else {
        console.log(`Using institution "${institution.name}": ${institution.id}`)
    }

    const requisitionReference = randomUUID()
    const apiRequisition: ApiRequisition = await nordigenClient.requisition.createRequisition({
        redirectUrl: input.RequisitionCompleteCallbackURL,
        institutionId: institution.id,
        reference: requisitionReference,
        agreement: undefined,
        userLanguage: undefined,
        redirectImmediate: false,
        accountSelection: false,
        ssn: "",
    })
    console.log(`Created requisition reference ${requisitionReference} with API`)
    const requisitionExpires = getUnixTime(addDays(new Date(), TRANSACTION_DAYS))

    const requisition: Requisition = {
        id: apiRequisition.id,
        reference: requisitionReference,
        confirmLink: apiRequisition.link,
        created: getUnixTime(new Date(apiRequisition.created)),
        expires: requisitionExpires,
        institutionId: apiRequisition.institution_id,
        status: "Pending",
        taskToken: input.TaskToken,
        language: apiRequisition.user_language,
    }
    await dynamoDbClient.send(
        new PutItemCommand({
            TableName: input.Requisition.TableName,
            Item: marshall(requisition, { removeUndefinedValues: true }),
        })
    )
    console.log(`Inserted requisition reference ${requisition.reference} into DynamoDB`)

    await snsClient.send(new PublishCommand({
        TopicArn: input.NotificationTopicARN,
        Message: `Please click the following link to authorize ingest-shared-expenses on AWS to read your bank account transactions, in order to export these to google sheets\n\n${requisition.confirmLink}`,
        Subject: "A GoCardless Bank Account Data requisition requests requires your approval"
    }))
    console.log("Published notification to SNS")

    return {
        Reference: requisition.reference,
        Updated: true
    }
}

const useExistingRequisiton = async (input: UpdateRequisitionInput, sfnClient: SFNClient): Promise<UpdateRequisitionOutput> => {
    const output: UpdateRequisitionOutput = {
        Reference: input.Requisition.Reference,
        Updated: false
    }
    await sfnClient.send(new SendTaskSuccessCommand({
        taskToken: input.TaskToken,
        output: JSON.stringify(output)
    }))
    return output
}

export const handler: Handler = async (input: UpdateRequisitionInput): Promise<UpdateRequisitionOutput> => {
    const existingRequisitonResponse = await dynamoDbClient.send(
        new GetItemCommand({
            Key: marshall({ reference: input.Requisition.Reference }),
            TableName: input.Requisition.TableName,
        })
    )
    
    if (existingRequisitonResponse.Item === undefined) {
        console.log(`Existing requisition ${input.Requisition.Reference} not found`)
        return useNewRequisition(input)
    }

    const existingRequisition: Requisition = unmarshall(existingRequisitonResponse.Item) as Requisition

    const requisitionValidityHours = differenceInHours(fromUnixTime(existingRequisition.expires), new Date())
    if (requisitionValidityHours >= 1) {
        console.log(`Requisition ${input.Requisition.Reference} still valid, not updating`)
        return useExistingRequisiton(input, sfnClient)
    } else {
        console.log(`Requisition ${input.Requisition.Reference} expiring soon, renewing`)
        return useNewRequisition(input)
    }
}
