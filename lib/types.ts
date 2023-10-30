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

export type { Requisition, ConfirmationStatus, ExpiringValue }
