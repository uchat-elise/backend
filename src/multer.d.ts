declare module 'multer' {
  import type { RequestHandler } from 'express';

  interface File {
    originalname: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  }

  interface MulterInstance {
    single(fieldName: string): RequestHandler;
  }

  interface MulterFactory {
    (options?: { storage?: unknown; limits?: { fileSize?: number } }): MulterInstance;
    memoryStorage(): unknown;
  }

  const multer: MulterFactory;
  export default multer;
}

declare namespace Express {
  namespace Multer {
    interface File {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    }
  }
}