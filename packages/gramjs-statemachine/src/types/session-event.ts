export interface DecryptedFrameDetails<TObject = unknown> {
  msgId: string;
  seqNo: number;
  object: TObject;
  requestName?: string;
}

export interface SessionEvent<TObject = unknown> extends DecryptedFrameDetails<TObject> {
  type: 'decrypted_frame';
}
