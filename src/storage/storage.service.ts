import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { R2Service } from '../r2/r2.service';
import { S3Service } from '../s3/s3.service';
import { promises as fs } from 'fs';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

type StorageDriver = 'cloudinary' | 'r2' | 's3' | 'local';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly cloudinary: CloudinaryService,
    private readonly r2: R2Service,
    private readonly s3: S3Service,
  ) {}

  async uploadFile(
    file: Express.Multer.File,
    folder: string = 'uploads',
  ): Promise<string> {
    const driver = this.getDriver();

    if (driver === 'cloudinary') {
      try {
        return await this.cloudinary.uploadFile(file, folder);
      } catch (error) {
        this.logger.error(
          `Cloudinary upload failed: ${this.errorMessage(error)}`,
        );
        throw error;
      }
    }

    if (driver === 's3') {
      return this.s3.uploadFile(file, folder);
    }

    if (driver === 'local') {
      return this.uploadLocally(file, folder);
    }

    // Default driver: R2 with S3 fallback
    try {
      return await this.r2.uploadFile(file, folder);
    } catch (error) {
      this.logger.warn(
        `R2 upload failed, falling back to S3: ${this.errorMessage(error)}`,
      );
      return this.s3.uploadFile(file, folder);
    }
  }

  async deleteFile(fileUrl: string): Promise<void> {
    if (!fileUrl) return;

    if (fileUrl.includes('res.cloudinary.com')) {
      await this.cloudinary.deleteFile(fileUrl);
      return;
    }

    const driver = this.getDriver();

    if (driver === 'cloudinary') {
      await this.cloudinary.deleteFile(fileUrl);
      return;
    }

    if (driver === 's3') {
      await this.s3.deleteFile(fileUrl);
      return;
    }

    await this.r2.deleteFile(fileUrl);
    await this.s3.deleteFile(fileUrl);
  }

  private async uploadLocally(
    file: Express.Multer.File,
    folder: string,
  ): Promise<string> {
    const uploadDir = join(process.cwd(), 'uploads', folder);
    await fs.mkdir(uploadDir, { recursive: true });

    const isImage = file.mimetype?.startsWith('image/');
    const ext = isImage ? '.webp' : extname(file.originalname);
    const filename = `${randomUUID()}${ext}`;
    const filePath = join(uploadDir, filename);

    const buffer = isImage
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

    await fs.writeFile(filePath, buffer);

    const appUrl =
      this.config.get<string>('APP_URL') ||
      `http://localhost:${this.config.get<string>('PORT') || 6000}`;
    return `${appUrl.replace(/\/+$/, '')}/${folder}/${filename}`;
  }

  private getDriver(): StorageDriver {
    const configuredDriver = this.config
      .get<string>('STORAGE_DRIVER')
      ?.toLowerCase();
    if (
      configuredDriver === 'cloudinary' ||
      configuredDriver === 'r2' ||
      configuredDriver === 's3' ||
      configuredDriver === 'local'
    ) {
      return configuredDriver as StorageDriver;
    }

    if (this.cloudinary.isReady()) {
      return 'cloudinary';
    }

    return 'r2';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
