# User Story: WebAuthn Registration (Passkeys)

**As an** authenticated user,  
**I want to** register a hardware security key or a platform passkey,  
**so that** I can use phishing-resistant multifactor authentication.

## API Example

### 1. Start Registration
`POST /mfa/webauthn/register/start`  
**Header**: `Authorization: Bearer <access_token>`

#### Success Response
`200 OK`

```json
{
  "options": {
    "publicKey": {
      "rp": { "name": "Hades Auth", "id": "localhost" },
      "user": { "id": "...", "name": "johndoe", "displayName": "johndoe" },
      "challenge": "...",
      "pubKeyCredParams": [...],
      "timeout": 60000,
      "attestation": "none"
    }
  },
  "registration_id": "uuid-v4-registration-session"
}
```

### 2. Finish Registration
`POST /mfa/webauthn/register/finish`  
**Header**: `Authorization: Bearer <access_token>`

#### Request
```json
{
  "registration_id": "uuid-v4-registration-session",
  "data": {
    "id": "...",
    "rawId": "...",
    "type": "public-key",
    "response": {
      "clientDataJSON": "...",
      "attestationObject": "..."
    }
  }
}
```

#### Success Response
`200 OK`

```json
{}
```
