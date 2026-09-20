import os
import uuid
import urllib.request

base = 'http://localhost:8001'
root = r'C:\Users\alber\hophacks'
files = ['IMG_5456.jpeg', 'IMG_6917.jpeg', 'IMG_7020.jpeg']


def multipart_body(fields, files):
    boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
    parts = []
    for key, value in fields:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    for fn in files:
        path = os.path.join(root, fn)
        with open(path, 'rb') as f:
            payload = f.read()
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{fn}"\r\nContent-Type: image/jpeg\r\n\r\n').encode() + payload + b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    body = b''.join(parts)
    return boundary, body


def call_verify(fn):
    boundary = '----WebKitFormBoundary' + uuid.uuid4().hex
    path = os.path.join(root, fn)
    with open(path, 'rb') as f:
        payload = f.read()
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fn}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()
        + payload
        + b'\r\n--' + boundary.encode() + b'--\r\n'
    )
    req = urllib.request.Request(base + '/verify', data=body, method='POST')
    req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode()


boundary, body = multipart_body([('name', 'Alice'), ('relationship', 'Mom')], files)
req = urllib.request.Request(base + '/enroll', data=body, method='POST')
req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
print('--- ENROLL ---')
with urllib.request.urlopen(req) as resp:
    print(resp.read().decode())

for fn in ['IMG_8422.jpeg', 'DSC00015.JPG']:
    print(f'--- VERIFY {fn} ---')
    print(call_verify(fn))
