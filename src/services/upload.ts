import { fileEnv } from '@/config/file';
import { edgeClient } from '@/libs/trpc/client';
import { API_ENDPOINTS } from '@/services/_url';
import { clientS3Storage } from '@/services/file/ClientS3';
import { FileMetadata } from '@/types/files';
import { FileUploadState, FileUploadStatus } from '@/types/files/upload';
import { uuid } from '@/utils/uuid';

export const UPLOAD_NETWORK_ERROR = 'NetWorkError';

const compressImageToBase64 = (file: File, maxSize: number) => {
  // 对图片进行压缩处理
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const img = new Image();
      img.src = reader.result as string;
      img.addEventListener('load', () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        let width = img.width;
        let height = img.height;
        let quality = 0.9;
        let dataURL = '';
        do {
          canvas.width = width;
          canvas.height = height;
          ctx?.clearRect(0, 0, width, height);
          ctx?.drawImage(img, 0, 0, width, height);
          dataURL = canvas.toDataURL('image/jpeg', quality);
          if (dataURL.length < maxSize) break;

          if (quality > 0.5) {
            quality -= 0.1;
          } else {
            width *= 0.9;
            height *= 0.9;
          }
        } while (dataURL.length > maxSize);

        resolve(dataURL);
      });
    });
    reader.addEventListener('error', reject);
    reader.readAsDataURL(file);
  });
};

class UploadService {
  uploadWithProgress = async (
    file: File,
    {
      onProgress,
      directory,
    }: {
      directory?: string;
      onProgress?: (status: FileUploadStatus, state: FileUploadState) => void;
    },
  ): Promise<FileMetadata> => {
    const xhr = new XMLHttpRequest();

    const { preSignUrl, ...result } = await this.getSignedUploadUrl(file, directory);

    // [custom] if the file is image, we don't need to upload it, just return the metadata
    if (file.type.startsWith('image')) {
      // base 64
      result.path = await compressImageToBase64(file, 256 * 1024);
      return result;
    }

    let startTime = Date.now();
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const progress = Number(((event.loaded / event.total) * 100).toFixed(1));

        const speedInByte = event.loaded / ((Date.now() - startTime) / 1000);

        onProgress?.('uploading', {
          // if the progress is 100, it means the file is uploaded
          // but the server is still processing it
          // so make it as 99.9 and let users think it's still uploading
          progress: progress === 100 ? 99.9 : progress,
          restTime: (event.total - event.loaded) / speedInByte,
          speed: speedInByte,
        });
      }
    });

    xhr.open('POST', preSignUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    const data = await file.arrayBuffer();

    await new Promise((resolve, reject) => {
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress?.('success', {
            progress: 100,
            restTime: 0,
            speed: file.size / ((Date.now() - startTime) / 1000),
          });
          resolve(xhr.response);
        } else {
          reject(xhr.statusText);
        }
      });
      xhr.addEventListener('error', () => {
        if (xhr.status === 0) reject(UPLOAD_NETWORK_ERROR);
        else reject(xhr.statusText);
      });
      xhr.send(data);
    });

    return result;
  };

  uploadToClientS3 = async (hash: string, file: File): Promise<FileMetadata> => {
    await clientS3Storage.putObject(hash, file);

    return {
      date: (Date.now() / 1000 / 60 / 60).toFixed(0),
      dirname: '',
      filename: file.name,
      path: `client-s3://${hash}`,
    };
  };

  /**
   * get image File item with cors image URL
   * @param url
   * @param filename
   * @param fileType
   */
  getImageFileByUrlWithCORS = async (url: string, filename: string, fileType = 'image/png') => {
    const res = await fetch(API_ENDPOINTS.proxy, { body: url, method: 'POST' });
    const data = await res.arrayBuffer();

    return new File([data], filename, { lastModified: Date.now(), type: fileType });
  };

  private getSignedUploadUrl = async (
    file: File,
    directory?: string,
  ): Promise<
    FileMetadata & {
      preSignUrl: string;
    }
  > => {
    const filename = `${uuid()}.${file.name.split('.').at(-1)}`;

    // 精确到以 h 为单位的 path
    const date = (Date.now() / 1000 / 60 / 60).toFixed(0);
    const dirname = `${directory || fileEnv.NEXT_PUBLIC_S3_FILE_PATH}/${date}`;
    const pathname = `${dirname}/${filename}`;

    const preSignUrl = await edgeClient.upload.createS3PreSignedUrl.mutate({ pathname });

    return {
      date,
      dirname,
      filename,
      path: pathname,
      preSignUrl,
    };
  };
}

export const uploadService = new UploadService();
