# User Story: TOTP Setup

**As an** authenticated user,  
**I want to** set up TOTP (Time-based One-Time Password) on my account,  
**so that** I can add an extra layer of security using an authenticator app.

## API Example

### 1. Request Setup
`POST /mfa/totp/setup`  
**Header**: `Authorization: Bearer <access_token>`

#### Success Response
`200 OK`

```json
{
  "setup_id": "uuid-v4-setup-session",
  "secret": "JBSWY3DPEHPK3PXP",
  "qr_code": "data:image/png;base64,..."
}
```

### 2. Verify and Enable
`POST /mfa/totp/verify`  
**Header**: `Authorization: Bearer <access_token>`

#### Request
```json
{
  "setup_id": "uuid-v4-setup-session",
  "code": "123456"
}
```

#### Success Response
`200 OK`

```json
{}
```
