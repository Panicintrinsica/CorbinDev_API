# User Story: Global Revocation and Banning (Admin)

**As a** superadmin,  
**I want to** globally ban a user or revoke all their active sessions,  
**so that** I can protect the platform from compromised accounts or malicious actors.

## API Example

### 1. Global Ban
`POST /admin/users/:user_id/ban`  
**Header**: `Authorization: Bearer <superadmin_access_token>`

Sets `global_status` to `suspended_global` and invalidates all refresh tokens for that user.

#### Success Response
`200 OK`

```json
{}
```

### 2. Revoke All Sessions
`POST /admin/users/:user_id/revoke-tokens`  
**Header**: `Authorization: Bearer <superadmin_access_token>`

Invalidates all active refresh tokens for the user without changing their account status.

#### Success Response
`200 OK`

```json
{}
```
