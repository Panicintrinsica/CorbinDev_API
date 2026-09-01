# User Story: Delete Account

**As an** authenticated user,  
**I want to** permanently delete my account and all associated tokens by providing my current password,  
**so that** my personal data is removed from the platform and accidental deletion is prevented.

## API Example

### Request
`DELETE /user/account`  
**Header**: `Authorization: Bearer <access_token>`

```json
{
  "password": "SecurePassword123!"
}
```

### Success Response
`200 OK`

```json
{}
```

### Error Response (Unauthorized)
`401 Unauthorized`

```json
{
  "error": "Unauthorized"
}
```
