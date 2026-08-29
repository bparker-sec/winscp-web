import { describe, it, expect } from 'vitest';
import { signRequest, encodeRfc3986 } from './sigv4';

// Official AWS "Signature Version 4 test suite" GET Object example:
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// GET https://examplebucket.s3.amazonaws.com/test.txt with Range: bytes=0-9
const AWS_VECTOR = {
  method: 'GET',
  url: 'https://examplebucket.s3.amazonaws.com/test.txt',
  region: 'us-east-1',
  service: 's3',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  date: new Date('2013-05-24T00:00:00Z'),
  emptyPayloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  expectedSignature: 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
};

describe('SigV4 official AWS test vector', () => {
  it('produces the documented signature for the GET Object example', async () => {
    const headers = await signRequest({
      method: AWS_VECTOR.method,
      url: AWS_VECTOR.url,
      headers: {
        Range: 'bytes=0-9',
        'x-amz-content-sha256': AWS_VECTOR.emptyPayloadHash,
      },
      region: AWS_VECTOR.region,
      service: AWS_VECTOR.service,
      accessKeyId: AWS_VECTOR.accessKeyId,
      secretAccessKey: AWS_VECTOR.secretAccessKey,
      dateOverride: AWS_VECTOR.date,
    });

    expect(headers['x-amz-date']).toBe('20130524T000000Z');
    expect(headers['Authorization']).toContain(
      `Credential=${AWS_VECTOR.accessKeyId}/20130524/us-east-1/s3/aws4_request`,
    );
    expect(headers['Authorization']).toContain(
      'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
    expect(headers['Authorization']).toContain(`Signature=${AWS_VECTOR.expectedSignature}`);
  });
});

describe('encodeRfc3986', () => {
  it('encodes reserved characters but leaves unreserved ones', () => {
    expect(encodeRfc3986('a b')).toBe('a%20b');
    expect(encodeRfc3986("a!*'()b")).toBe('a%21%2A%27%28%29b');
    expect(encodeRfc3986('-_.~')).toBe('-_.~');
  });
});
