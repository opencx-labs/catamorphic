export type FilePreviewInput =
  | { filePath: string; projectId?: string }
  | { document: { name: string; mediaType: string; dataBase64: string } };
