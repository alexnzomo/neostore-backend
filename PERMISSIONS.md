# Mwechestore — Role Permissions Matrix

Last updated: <date>

## Roles

- **customer** — default role on registration. Can browse, order, review.
- **vendor** — sells products. Can create/edit own products, see own orders (scoped), mark orders as `processing`.
- **agent** — delivers orders. Can update delivery status on assigned orders, record cash on assigned orders.
- **station_manager** — runs a pickup station. Can update delivery status on pickup orders at their station, record collections.
- **admin** — staff with operational access. Can manage most things except role changes, user deletion, and financial settings.
- **owner** — ultimate authority. Can do everything. There should always be at least 1 owner.

## Permission Matrix

### Users & Roles

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| Register | ✅ | — | — | — | — | — |
| Login | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reset own password | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Change own email/phone | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Change own role | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Change another user's role | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Suspend user | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Suspend another admin | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Delete user | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Grant "finance approver" flag | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Assign station to manager | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Unassign station manager | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

### Products & Categories

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| Browse products | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create product | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Edit own product | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Edit any product | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Archive own product | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Archive any product | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Create/edit/delete categories | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Sponsor own product (wallet/Stripe/M-Pesa) | ❌ | ✅ | ❌ | ❌ | — | — |
| Create/edit/delete banners | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Create/delete discounts | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

### Orders

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| Create order | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View own orders | ✅ | — | — | — | — | — |
| View orders for own products (scoped, redacted) | — | ✅ | — | — | — | — |
| View orders assigned to self | — | — | ✅ | — | — | — |
| View orders at own station | — | — | — | ✅ | — | — |
| View any order | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Update status: pending → processing (own products) | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Update status: any transition | ❌ | ❌ | ✅* | ✅* | ✅ | ✅ |
| Cancel order (own order, before shipped) | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Cancel any order (before shipped) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Refund order | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Mark order as fully paid | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Record cash payment | ❌ | ❌ | ✅* | ✅* | ✅ | ✅ |
| Verify manual payment | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

*Scoped: agent only on assigned orders, station_manager only on pickup orders at their station.

### Pickup Stations

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| Submit pickup station application | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View pending pickup applications | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Approve/reject pickup applications | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| View own station details | — | — | — | ✅ | — | — |
| Create pickup station (bypassing application) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Update pickup station | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Delete pickup station | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

### Vendor/Agent Applications

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| Apply as vendor/agent | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View pending applications | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Approve/reject applications | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| View application documents (proxied) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

### Identity Verification (KYC)

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| Submit KYC | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View own KYC status | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View pending KYC applications | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Approve/reject KYC | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| View KYC documents (proxied) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

### Wallet

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| View own wallet balance | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View own transactions | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Top up wallet (Stripe/M-Pesa) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Transfer to another user | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Pay order from wallet | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View another user's transactions | ❌ | ❌ | ❌ | ❌ | ✅ (audited) | ✅ (not audited) |
| Manually credit wallet | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Reverse transaction | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### Withdrawals

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| Request withdrawal (own) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View own withdrawal history | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View all pending withdrawals | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Approve/reject/complete withdrawals | ❌ | ❌ | ❌ | ❌ | See below* | ✅ |

*Admin approval rules:
- Admin without `canApproveWithdrawals` flag: **cannot** approve any withdrawal
- Admin with `canApproveWithdrawals` flag: **can** approve up to `withdrawal_approval_threshold` (default 20,000 KES)
- Owner can approve any amount
- Owner's own withdrawal requests auto-approve (skip `pending` state)

### Settlements

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| View own settlements | — | ✅ | ✅ | ✅ | — | — |
| View all settlements | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Mark settlement as paid | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

*Settlement payment requires recipient to have verified KYC. Otherwise 400 "KYC not verified. Cannot process payout."

### Settings

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| View public settings (stripe key, fees, etc.) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Change global commission | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Change deposit percentage | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Change agent/station fee | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Change sponsorship fee | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Change referral percentage | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Change minimum referral order | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Change cash payment settings | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Change KYC enforcement settings | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Change shipping rates | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Change withdrawal fees | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Change withdrawal approval threshold | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Freeze/unfreeze withdrawals | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |

### Notifications

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| View own notifications | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Mark own notifications read | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Send notification to any user | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |

### Audit & Reports

| Action | customer | vendor | agent | station_manager | admin | owner |
|---|---|---|---|---|---|---|
| View audit log | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| View platform reports | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

---

## Notes

- **Always have at least 1 owner.** If the owner accidentally changes their own role (blocked by FIX 3.5), they cannot recover without DB intervention. In practice, this is prevented by the guard.
- **Suspending an admin:** only the owner can suspend another admin. This prevents mutual lockout between admins.
- **KYC documents** (national ID, selfie, proof of address) are accessed via backend proxy. URLs are never exposed to the frontend. Every view logged to `AuditLog`.
- **Wallet PIN:** required for order payment, transfer, and withdrawal request. Cooldown enforced after forgot-reset (24h) or change (1h) — blocks wallet payment, transfer, and withdrawal during cooldown.
- **Settlement payout to vendor/agent/station:** only possible if recipient has verified KYC.
- **Deleting a user:** refused if they have active orders, pending settlements, or are a station manager.
- **Deleting a category:** refused if any product uses it (should be — depends on current code; verify).

---

## Changing this document

Permissions are enforced in code across:
- `middleware/roleCheck.js` (`allowRoles`)
- `middleware/auth.js` (`protect`)
- `middleware/kyc.js` (`requireKYC`)
- Individual route handlers (scope checks)

If you change a permission, update both the code and this document.