import os
import uuid
import urllib.request

base = "http://127.0.0.1:8001"
root = os.path.dirname(__file__)
files = ["IMG_5456.jpeg", "IMG_6917.jpeg", "IMG_7020.jpeg", "IMG_8422.jpeg", "DSC00015.JPG"]


def enroll():
    boundary = "----FaceTest" + uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nMultiFaceTest\r\n'.encode(),
        f'--{boundary}\r\nContent-Disposition: form-data; name="relationship"\r\n\r\nTest\r\n'.encode(),
    ]
    for filename in files:
        payload = open(os.path.join(root, filename), "rb").read()
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{filename}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()
            + payload
            + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    request = urllib.request.Request(base + "/enroll", data=b"".join(parts), method="POST")
    request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(request, timeout=120) as response:
        print("ENROLL", response.status, response.read().decode())


def verify(filename):
    boundary = "----FaceTest" + uuid.uuid4().hex
    payload = open(os.path.join(root, filename), "rb").read()
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()
        + payload
        + f"\r\n--{boundary}--\r\n".encode()
    )
    request = urllib.request.Request(base + "/verify", data=body, method="POST")
    request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    with urllib.request.urlopen(request, timeout=120) as response:
        print("VERIFY", filename, response.status, response.read().decode())


enroll()
for filename in files:
    verify(filename)
