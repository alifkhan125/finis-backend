import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extname } from 'path';
import sharp from 'sharp';
import { randomUUID } from 'crypto';

@Injectable()
export class R2Service {
  private r2?: S3Client;
  private bucket?: string;
  private publicBaseUrl?: string;

  constructor(private config: ConfigService) {
    const accountId = this.config.get<string>('R2_ACCOUNT_ID');
    const configuredEndpoint = this.config.get<string>('R2_ENDPOINT');
    const endpoint =
      configuredEndpoint ||
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY');
    this.bucket =
      this.config.get<string>('R2_BUCKET_NAME') ||
      this.config.get<string>('R2_BUCKET');
    this.publicBaseUrl = this.config
      .get<string>('R2_PUBLIC_URL')
      ?.replace(/\/+$/, '');

    if (
      !endpoint ||
      !accessKeyId ||
      !secretAccessKey ||
      !this.bucket ||
      !this.publicBaseUrl
    ) {
      return;
    }

    this.r2 = new S3Client({
      region: this.config.get<string>('R2_REGION') || 'auto',
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: string = 'uploads',
  ): Promise<string> {
    if (!this.r2 || !this.bucket || !this.publicBaseUrl) {
      throw new Error('R2 storage is not configured');
    }

    const isImage = file.mimetype.startsWith('image/');
    const optimizedBuffer = isImage
      ? await sharp(file.buffer)
          .resize({
            width: 1600,
            height: 1600,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 80 })
          .toBuffer()
      : file.buffer;

    const ext = isImage ? '.webp' : extname(file.originalname);
    const contentType = isImage ? 'image/webp' : file.mimetype;
    const key = `${folder}/${randomUUID()}${ext}`;

    await this.r2.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: optimizedBuffer,
        ContentType: contentType,
      }),
    );

    return `${this.publicBaseUrl}/${key}`;
  }

  async deleteFile(fileUrl: string): Promise<void> {
    try {
      if (!this.r2 || !this.bucket) {
        return;
      }

      let key = fileUrl.replace(/^\/+/, '');

      try {
        const url = new URL(fileUrl);
        key = url.pathname.replace(/^\/+/, '');

        if (key.startsWith(`${this.bucket}/`)) {
          key = key.slice(this.bucket.length + 1);
        }
      } catch {
        // Keep raw key fallback.
      }

      if (!key) return;

      await this.r2.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch {
      // ignore
    }
  }
}
