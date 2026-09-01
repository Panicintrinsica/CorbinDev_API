# User Story: Login

**As a** registered user,  
**I want to** log in using either my username or my email,  
**so that** I can securely access my account.

## API Example

### Request
`POST /auth/login`  

**Mandatory Headers**:
- `X-Client-ID`: The ID of the application agent.
- `X-Realm-ID`: The UUID of the security realm (domain) being accessed.

**Optional Headers**:
- `X-Device-ID`: Unique identifier for the hardware/installation (for session isolation).

#### Request Body
```json
{
  "identity": "johndoe",
  "password": "SecurePassword123!"
}
```

### Success Response (MFA Required)
`200 OK`

```json
{
  "mfa_required": true,
  "mfa_token": "uuid-v4-mfa-session-token"
}
```

### Success Response (MFA Not Enabled)
`200 OK`

The `access_token` returned will contain both **Global Roles** (e.g., `g_subscriber`) and **Realm Permissions** (e.g., `guildhall:post:write:shared`) specific to the requested `X-Realm-ID`.

```json
{
  "access_token": "v4.public....",
  "refresh_token": "uuid-v4-refresh-id"
}
```

### Error Responses

#### Missing Headers
`400 Bad Request`
```json
{
  "error": "X-Realm-ID header required"
}
```

#### Invalid Credentials
`401 Unauthorized`
```json
{
  "error": "Unauthorized"
}
```
