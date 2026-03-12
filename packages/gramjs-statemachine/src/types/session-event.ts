export type SessionEvent =
  | {
      type: 'rpc_result';
      reqMsgId: string;
      requestName: string;
      result: unknown;
      requestId?: string;
    }
  | {
      type: 'update';
      update: unknown;
      msgId: string;
      seqNo: number;
      envelopeClassName?: string;
    };
