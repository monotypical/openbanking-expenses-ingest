import { Handler } from "aws-lambda"
import { endOfMonth, format, parseISO, startOfMonth, subMonths } from "date-fns"
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn"

type CalculateDateRangeOutput = {
    StateMachineArgs: StateMachineArgs,
    StateMachineExecutionId?: string
}

type TransactionDetails = {
    DateFrom: string
    DateTo: string
}
type StateMachineArgs = {
    TransactionDetails: TransactionDetails
}


const DATE_FORMAT = "yyyy-MM-dd"
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN

const sfnClient = new SFNClient()

export const handler: Handler = async (): Promise<CalculateDateRangeOutput> => {
    const now = new Date()
    const dateInPreviousMonth = subMonths(now, 1)
    const startDate = startOfMonth(dateInPreviousMonth)
    const endDate = endOfMonth(dateInPreviousMonth)

    const args: StateMachineArgs = {
        TransactionDetails: {
            DateFrom: format(startDate, DATE_FORMAT),
            DateTo: format(endDate, DATE_FORMAT)
        }
    }
    console.log("Invoking state machine with arguments:")
    console.log(JSON.stringify(args))
    const sfnResponse = await sfnClient.send(new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        input: JSON.stringify(args)
    }))
    console.log(`Invoked state machine, execution ID: ${sfnResponse.executionArn}`)
    return {
        StateMachineArgs: args,
        StateMachineExecutionId: sfnResponse.executionArn
    }
}