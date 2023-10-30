import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb"
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb"
import { Handler } from "aws-lambda"
import { addDays, differenceInHours, fromUnixTime, getUnixTime } from "date-fns"
import NordigenClient from "nordigen-node"
import { v4 as uuidv4 } from "uuid"
import type { ExpiringValue, Requisition } from "../../lib/types"

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
}

type UpdateRequisitionOutput = {
    AccessToken: ExpiringValue<string>
    Requisition: {
        Reference: string
        ConfirmLink?: string
    }
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

const TRANSACTION_DAYS = 90

export const handler: Handler = async (input: UpdateRequisitionInput): Promise<UpdateRequisitionOutput> => {
    const existingRequisition: Requisition = unmarshall(
        (await dynamoDbClient.send(
            new GetItemCommand({
                Key: { reference: { "S": input.Requisition.Reference} },
                TableName: input.Requisition.TableName,
            })
        )).Item!
    ) as Requisition

    const requisitionValidityHours = differenceInHours(fromUnixTime(existingRequisition.expires), new Date())
    if (requisitionValidityHours >= 1) {
        console.log("Requisition still valid, not updating")
        return {
            AccessToken: input.AccessToken,
            Requisition: {
                Reference: existingRequisition.reference
            }
        }
    }

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

    const requisitionReference = uuidv4()
    const apiRequisition: ApiRequisition = await nordigenClient.requisition.createRequisition({
        redirectUrl: "https://example.com",
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
        language: apiRequisition.user_language,
    }
    console.log(JSON.stringify(requisition))
    await dynamoDbClient.send(
        new PutItemCommand({
            TableName: input.Requisition.TableName,
            Item: marshall(requisition, { removeUndefinedValues: true }),
        })
    )
    console.log(`Inserted requisition reference ${requisition.reference} into DynamoDB`)

    return {
        AccessToken: input.AccessToken,
        Requisition: {
            Reference: requisition.reference,
            ConfirmLink: requisition.confirmLink,
        },
    }
}
