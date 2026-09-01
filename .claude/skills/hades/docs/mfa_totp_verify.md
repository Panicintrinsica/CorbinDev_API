# User Story: MFA Verification (TOTP)

**As a** user with TOTP enabled,  
**I want to** verify my identity using a one-time code during login,  
**so that** I can securely access my account after providing my password.

## API Example

### Request
`POST /mfa/verify/totp`  

**Mandatory Headers**:
- `X-Client-ID`: The ID of the application agent.
- `X-Realm-ID`: The UUID of the security realm (domain).

**Optional Headers**:
- `X-Device-ID`: Unique identifier for the hardware/installation.

#### Request Body
```json
{
  "mfa_token": "uuid-v4-mfa-session-token",
  "code": "123456"
}
```

### Success Response
`200 OK`

```json
{
  "access_token": "v4.public....",
  "refresh_token": "uuid-v4-refresh-id"
}
```

### Error Response (Unauthorized)
`401 Unauthorized`

```json
{
  "error": "Unauthorized"
}
```
