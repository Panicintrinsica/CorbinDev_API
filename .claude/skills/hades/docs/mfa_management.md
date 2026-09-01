# User Story: MFA Management

**As an** authenticated user,  
**I want to** manage my multifactor authentication settings,  
**so that** I can disable factors I no longer use or revoke compromised passkeys.

## API Examples

### 1. Disable TOTP
`POST /mfa/totp/disable`  
**Header**: `Authorization: Bearer <access_token>`

Removes the TOTP secret from the account. If no passkeys are registered, MFA is disabled for the user.

#### Request
```json
{
  "password": "SecurePassword123!"
}
```

#### Success Response
`200 OK`

```json
{}
```

### 2. Revoke Passkey
`DELETE /mfa/passkeys/:cred_id`  
**Header**: `Authorization: Bearer <access_token>`

Removes a specific WebAuthn passkey by its Base64-encoded credential ID.

#### Success Response
`200 OK`

```json
{}
```

### 3. Global MFA Reset (Nuclear Option)
`POST /mfa/disable`  
**Header**: `Authorization: Bearer <access_token>`

Removes **all** MFA factors (TOTP and all Passkeys) and sets `is_enabled` to false.

#### Request
```json
{
  "password": "SecurePassword123!"
}
```

#### Success Response
`200 OK`

```json
{}
```
