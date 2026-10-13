import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { Readable } from 'stream';
import sharp from 'sharp';

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private isConfigured = false;

  constructor(private readonly config: ConfigService) {
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');

    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      this.isConfigured = true;
      this.logger.log(
        `Cloudinary initialized successfully for cloud: ${cloudName}`,
      );
    } else {
      this.logger.warn('Cloudinary credentials are not fully configured');
    }
  }

  isReady(): boolean {
    return this.isConfigured;
  }

  async uploadFile(
    file: Express.Multer.File,
    folder: string = 'uploads',
  ): Promise<string> {
    if (!this.isConfigured) {
      throw new Error('Cloudinary storage is not configured');
    }

    const isImage = file.mimetype?.startsWith('image/');
    let bufferToUpload = file.buffer;

    if (isImage) {
      try {
        bufferToUpload = await sharp(file.buffer)
          .resize({
            width: 1600,
            height: 1600,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 80 })
          .toBuffer();
      } catch (err) {
        // If sharp optimization fails, fallback to raw buffer
        bufferToUpload = file.buffer;
      }
    }

    return new Promise<string>((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'auto',
          format: isImage ? 'webp' : undefined,
        },
        (error: any, result?: UploadApiResponse) => {
          if (error || !result) {
            this.logger.error('Cloudinary upload stream error:', error);
            return reject(
              error || new Error('Cloudinary upload returned empty result'),
            );
          }
          resolve(result.secure_url);
        },
      );

      const stream = new Readable();
      stream.push(bufferToUpload);
      stream.push(null);
      stream.pipe(uploadStream);
    });
  }

  async deleteFile(fileUrl: string): Promise<void> {
    if (!this.isConfigured || !fileUrl) {
      return;
    }

    try {
      // Extract public_id from Cloudinary URL
      // e.g. https://res.cloudinary.com/cloud_name/image/upload/v12345/folder/file.webp -> folder/file
      const matches = fileUrl.match(
        /\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/,
      );
      if (!matches || !matches[1]) {
        return;
      }

      const publicId = decodeURIComponent(matches[1]);
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
      await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
    } catch (err) {
      this.logger.warn(
        `Failed to delete Cloudinary file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
