type Requisition = {
  id: string
  reference: string
  confirmLink: string
  created: number
  expires: number
  institutionId: string
  status: ConfirmationStatus
  taskToken: string
  language: string
}

type ConfirmationStatus =  "Confirmed" | "Pending"

type ExpiringValue<V> = {
  Value: V
  Expires: number
}

type Updateable = {
  Updated: boolean
}

type ApiCredential = ExpiringValue<string> & Updateable

export type { Requisition, ConfirmationStatus, ExpiringValue, Updateable, ApiCredential }
