# 📦 TradeCen Courier | Enterprise Logistics & Terminal Ledger System

TradeCen Courier is a high-performance, hyper-local, and inter-district courier logistics platform designed to automate hub operations, manage the HQ Central Finance Ledger, and streamline merchant payouts.

Featuring a premium dark-teal corporate design, the platform includes dynamic pricing, automated hub routing, role-based dashboards, and centralized system configuration.

---

## 🛠️ Core Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React.js, Tailwind CSS | Responsive single-page application |
| Backend | Node.js, Express.js | RESTful API and server-side logic |
| Database | MongoDB | Data storage and geographical lookups |
| Feedback UI | SweetAlert2 | Interactive alerts and notifications |

---

## 🚀 Key Operational Flows & Business Logic

### 1. Dynamic Pricing & Coverage Engine

Geographical coverage and pricing rules are stored in MongoDB, allowing administrators to manage them dynamically.

- **Dependent Dropdowns:** Destination selection follows the hierarchy `Region → District → Local Sub-Hub (Covered Area)`.
- **Coverage Management:** Inactive areas are excluded from merchant booking options.
- **Dynamic Pricing:** Delivery costs are calculated based on base rates, additional weight, and COD fees.


### 2. HQ Central Finance Ledger

The central ledger manages hub cash reporting and financial reconciliation between regional hubs and headquarters.

- **Hub Audit Submissions:** Hub managers submit parcel volumes, cash receipts, and transaction slip references.
- **HQ Reconciliation:** The HQ administrator verifies submitted bank receipts and approves transactions to update the central capital balance.

### 3. Automated Hub Sorting & Routing

Hub manager dashboards organize parcels into local delivery and inter-hub dispatch workflows.

- **Local Delivery Allocation:** Parcels destined for the current hub are prioritized for last-mile delivery using the hub-matching condition `receiverCity === managerData.hubName`.
- **Inter-Hub Dispatch:** Picked-up parcels destined for other districts are organized for dispatch to their destination hubs.

### 4. Global System Control Room (`/system-settings`)

The centralized settings panel allows administrators to manage system-wide configurations without redeploying the application.

- **Logistics Parameters:** Configure inside-city rates, outside-city rates, and COD commission percentages.
- **System Operations:** Enable maintenance mode or suspend public registration when necessary.

---

## 🗄️ Database Schema Blueprint

### 1. `coverages` Collection

```json
{
  "_id": "geo_dhaka_01",
  "region": "Dhaka",
  "district": "Dhaka",
  "city": "Dhaka",
  "covered_area": [
    "Uttara",
    "Dhanmondi",
    "Mirpur",
    "Mohammadpur"
  ],
  "status": "active",
  "longitude": 90.4125,
  "latitude": 23.8103
}
```

### 2. `pricing` Collection

```json
{
  "_id": "global_pricing_rules",
  "insideCity": {
    "baseCost": 60,
    "extraWeightFee": 20
  },
  "outsideCity": {
    "baseCost": 120,
    "extraWeightFee": 30
  },
  "codFeePercentage": 1
}
```

---