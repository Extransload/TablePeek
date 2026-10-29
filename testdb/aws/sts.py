"""A stand-in for AWS STS, for the mongodb-aws test profile.

MongoDB Enterprise checks a MONGODB-AWS login by passing the request the
client signed (sts:GetCallerIdentity) on to STS, here this server (the
mongod parameter awsSTSUrl). It checks the signature as STS would, with the
one test key it knows, and answers with the caller's ARN:

- AKIATABLEPEEKTEST / tablepeek_aws_secret: the IAM user
  arn:aws:iam::123456789012:user/tablepeek;
- the same key with the session token tablepeek_session_token: the assumed
  role arn:aws:sts::123456789012:assumed-role/tablepeek-role/tablepeek,
  which MongoDB knows as arn:aws:sts::123456789012:assumed-role/tablepeek-role/*.

Anything else gets STS's own refusal. It serves HTTPS with the test server
certificate (testdb/x509/gen.sh), as MongoDB takes only an https:// STS.
"""

import hashlib
import hmac
import http.server
import ssl
import sys

ACCOUNT = "123456789012"
KEY_ID = "AKIATABLEPEEKTEST"
SECRET = "tablepeek_aws_secret"
SESSION_TOKEN = "tablepeek_session_token"


def sign(key: bytes, text: str) -> bytes:
    return hmac.new(key, text.encode(), hashlib.sha256).digest()


def expected_signature(headers, body: bytes, signed: list[str], scope: list[str]) -> str:
    """SigV4 of a POST to / with no query, over the headers the client signed."""
    canonical_headers = "".join(
        f"{name}:{' '.join((headers.get(name) or '').split())}\n" for name in signed
    )
    canonical = "\n".join(
        [
            "POST",
            "/",
            "",
            canonical_headers,
            ";".join(signed),
            hashlib.sha256(body).hexdigest(),
        ]
    )
    date, region, service, terminator = scope
    to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            headers.get("x-amz-date") or "",
            "/".join(scope),
            hashlib.sha256(canonical.encode()).hexdigest(),
        ]
    )
    key = ("AWS4" + SECRET).encode()
    for part in (date, region, service, terminator):
        key = sign(key, part)
    return hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()


class Sts(http.server.BaseHTTPRequestHandler):
    def refuse(self, code: str, message: str) -> None:
        sys.stderr.write(f"refused: {code}: {message}\n")
        body = (
            "<ErrorResponse xmlns=\"https://sts.amazonaws.com/doc/2011-06-15/\">"
            f"<Error><Type>Sender</Type><Code>{code}</Code><Message>{message}</Message></Error>"
            "<RequestId>tablepeek</RequestId></ErrorResponse>"
        ).encode()
        self.send_response(403)
        self.send_header("Content-Type", "text/xml")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        authorization = self.headers.get("Authorization") or ""
        fields = dict(
            part.strip().split("=", 1)
            for part in authorization.removeprefix("AWS4-HMAC-SHA256").split(",")
            if "=" in part
        )
        scope = fields.get("Credential", "").split("/")
        if len(scope) != 5 or scope[0] != KEY_ID:
            return self.refuse("InvalidClientTokenId", "The security token included in the request is invalid.")
        signed = fields.get("SignedHeaders", "").split(";")
        if fields.get("Signature") != expected_signature(self.headers, body, signed, scope[1:]):
            return self.refuse("SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided.")
        token = self.headers.get("X-Amz-Security-Token")
        if token is None:
            arn = f"arn:aws:iam::{ACCOUNT}:user/tablepeek"
        elif token == SESSION_TOKEN:
            arn = f"arn:aws:sts::{ACCOUNT}:assumed-role/tablepeek-role/tablepeek"
        else:
            return self.refuse("InvalidClientTokenId", "The security token included in the request is invalid.")
        reply = (
            "<GetCallerIdentityResponse xmlns=\"https://sts.amazonaws.com/doc/2011-06-15/\">"
            f"<GetCallerIdentityResult><Arn>{arn}</Arn><UserId>{KEY_ID}</UserId>"
            f"<Account>{ACCOUNT}</Account></GetCallerIdentityResult>"
            "<ResponseMetadata><RequestId>tablepeek</RequestId></ResponseMetadata>"
            "</GetCallerIdentityResponse>"
        ).encode()
        sys.stderr.write(f"accepted: {arn}\n")
        self.send_response(200)
        self.send_header("Content-Type", "text/xml")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)


server = http.server.ThreadingHTTPServer(("0.0.0.0", 8443), Sts)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/certs/server.pem")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
