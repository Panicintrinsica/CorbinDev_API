# User Story: Update Profile

**As an** authenticated user,  
**I want to** update my username or email,  
**so that** I can keep my account information current.

## API Example

### Request
`PUT /user/profile`  
**Header**: `Authorization: Bearer <access_token>`

```json
{
  "username": "johnny_doe",
  "email": "john.new@example.com"
}
```

### Success Response
`200 OK`

```json
{
  "id": "uuid-v4-string",
  "username": "johnny_doe",
  "email": "john.new@example.com",
  "global_status": "active",
  "global_roles": ["g_subscriber"],
  "mfa_enabled": false,
  "totp_enabled": false,
  "passkeys_count": 0,
  "created_at": "2026-05-04T12:00:00Z",
  "updated_at": "2026-05-04T12:15:00Z"
}
```
