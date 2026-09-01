# User Story: Change Password

**As an** authenticated user,  
**I want to** change my password by providing my old password and a new one,  
**so that** I can maintain the security of my account.

## API Example

### Request
`POST /user/password`  
**Header**: `Authorization: Bearer <access_token>`

```json
{
  "old_password": "OldSecurePassword123!",
  "new_password": "NewSecurePassword456!"
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
