# User Story: WebAuthn Authentication (Passkeys)

**As a** user with WebAuthn enabled,  
**I want to** authenticate using my registered passkey,  
**so that** I can securely access my account without manually entering a code.

## API Example

### 1. Start Authentication
`POST /mfa/webauthn/auth/start`

#### Request
```json
{
  "mfa_token": "uuid-v4-mfa-session-token"
}
```

#### Success Response
`200 OK`

```json
{
  "options": {
    "publicKey": {
      "challenge": "...",
      "timeout": 60000,
      "rpId": "localhost",
      "allowCredentials": [...],
      "userVerification": "preferred"
    }
  },
  "auth_id": "uuid-v4-auth-session"
}
```

### 2. Finish Authentication
`POST /mfa/webauthn/auth/finish`  

**Mandatory Headers**:
- `X-Client-ID`: The ID of the application agent.
- `X-Realm-ID`: The UUID of the security realm (domain).

**Optional Headers**:
- `X-Device-ID`: Unique identifier for the hardware/installation.

#### Request Body
```json
{
  "mfa_token": "uuid-v4-mfa-session-token",
  "auth_id": "uuid-v4-auth-session",
  "data": {
    "id": "...",
    "rawId": "...",
    "type": "public-key",
    "response": {
      "clientDataJSON": "...",
      "authenticatorData": "...",
      "signature": "...",
      "userHandle": "..."
    }
  }
}
```

#### Success Response
`200 OK`

```json
{
  "access_token": "v4.public....",
  "refresh_token": "uuid-v4-refresh-id"
}
```
