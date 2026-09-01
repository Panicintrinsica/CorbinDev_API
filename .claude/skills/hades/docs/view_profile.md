# User Story: View Profile

**As an** authenticated user,  
**I want to** view my profile information,  
**so that** I can verify my account details and status.

## API Example

### Request
`GET /user/profile`  
**Header**: `Authorization: Bearer <access_token>`

### Success Response
`200 OK`

```json
{
  "id": "uuid-v4-string",
  "username": "johndoe",
  "email": "john@example.com",
  "global_status": "active",
  "global_roles": ["g_subscriber"],
  "mfa_enabled": true,
  "totp_enabled": true,
  "passkeys_count": 1,
  "created_at": "2026-05-04T12:00:00Z",
  "updated_at": "2026-05-04T12:00:00Z"
}
```
