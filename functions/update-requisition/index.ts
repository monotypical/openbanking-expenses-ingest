import { Handler } from "aws-lambda"
import NordigenClient from "nordigen-node"
import type { ExpiringValue } from "../../lib/types"
import { addDays, differenceInHours, fromUnixTime, getUnixTime } from "date-fns"

type UpdateRequisitionInput = {
    AccessToken: ExpiringValue<string>
    Requisition: ExpiringValue<string>
    Bank: {
        Name: string
        Country: string
    }
}

type UpdateRequisitionOutput = {
    AccessToken: ExpiringValue<string>
    Requisition: ExpiringValue<string> & { ConfirmLink?: string }
}

type Institution = {
    id: string
    name: string
    transaction_total_days: string
}

type Requisition = {
    id: string
    link: string
}

export const handler: Handler = async (input: UpdateRequisitionInput): Promise<UpdateRequisitionOutput> => {
    const requisitionValidityHours = differenceInHours(fromUnixTime(input.Requisition.Expires), new Date())
    if (requisitionValidityHours >= 1) {
        console.log("Requisition still valid, not updating")
        return {
            AccessToken: input.AccessToken,
            Requisition: input.Requisition
        }
    }

    const nordigenClient = new NordigenClient({ secretId: "Not used", secretKey: "Not used"})
    nordigenClient.token = input.AccessToken.Value

    const institutions: Institution[] = await nordigenClient.institution.getInstitutions({
        country: input.Bank.Country,
    })
    const institution = institutions.find((i) => i.name == input.Bank.Name)

    if (institution === undefined) {
        throw new Error(`Failed to find institution ${input.Bank.Name} in country ${input.Bank.Country}`)
    } else {
        console.log(`Using institution "${institution.name}": ${institution.id}`)
        console.log(`Transaction history available for ${institution.transaction_total_days} after requisition`)
    }

    const requisition: Requisition = await nordigenClient.requisition.createRequisition({
        redirectUrl: "https://example.com",
        institutionId: institution.id,
        agreement: undefined,
        userLanguage: undefined,
        redirectImmediate: false,
        accountSelection: false,
        reference: "",
        ssn: ""
    })
    const requisitionExpires = getUnixTime(addDays(new Date(), Number(institution.transaction_total_days)))

    return {
        AccessToken: input.AccessToken,
        Requisition: {
            Value: requisition.id,
            Expires: requisitionExpires,
            ConfirmLink: requisition.link
        }
    }
}
