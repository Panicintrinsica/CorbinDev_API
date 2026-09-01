# User Story: Realm Management (Admin)

**As a** superadmin,  
**I want to** create and manage security realms,  
**so that** I can isolate different applications and their permissions.

## API Example

### 1. Create Realm
`POST /admin/realms`  
**Header**: `Authorization: Bearer <superadmin_access_token>`

#### Request
The system will automatically generate a UUID for the realm based on the unique name.

```json
{
  "name": "Guildhall"
}
```

#### Success Response
`200 OK`

```json
{
  "_id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "Guildhall",
  "created_at": "2026-05-10T14:00:00Z"
}
```

### 2. Implementation Rules
- Realm IDs are immutable UUIDs.
- Realm names must be unique.
- Permissions in access tokens are scoped to the realm provided in the `X-Realm-ID` header.
