# Coding Standards & Naming Conventions

This document defines the mandatory coding standards and naming conventions for the project.  
All contributors must follow these rules to ensure consistency, readability, and maintainability.

---

## File Naming

- File names **must use kebab-case**
  - ✅ `example-something.config.js`
  - ❌ `exampleSomething.config.js`

- File names **must include their type**, separated by a dot (`.`)
  - ✅ `example.config.js`
  - ✅ `user.service.js`
  - ✅ `auth.controller.js`

---

## Variables & Functions

- **Variables** must be written in **camelCase**
  - ✅ `userName`
  - ✅ `totalCount`

- **Functions** must be written in **camelCase**
  - ✅ `getUserById()`
  - ✅ `createOrder()`

---

## Database Conventions

- **Database column names** must be written in **camelCase**
- This rule applies to **both SQL and NoSQL databases**
  - ✅ `createdAt`
  - ✅ `userId`
  - ✅ `orderStatus`

---

## Folder Naming

- Folder names must be **singular or plural based on their responsibility**
  - **Singular** → represents a single domain or concept  
    - ✅ `auth`
    - ✅ `user`
  - **Plural** → represents a collection or group  
    - ✅ `controllers`
    - ✅ `services`
    - ✅ `routes`

---

## Core Services Structure

- **Core services must only contain their configuration file**
- services/
- some-service/
- index.js

- Core services **must not contain business logic**
- All functions must be placed in **domain-specific folders** until they depend on external resources such as:
- `user`
- `auth`
- `admin`
- `product`

---

## Resource Boundaries

- **Each resource folder must contain only its own logic**
- Cross-resource responsibilities are **not allowed**
- A resource must not directly handle another resource’s work

---

## Routes

- **Route names must be written in kebab-case**
- ✅ `/some-endpoint`
- ❌ `/someEndpoint`
- ❌ `/some_endpoint`

---

## Enforcement

- These rules are **mandatory**
- Violations should be caught via:
- Code reviews
- ESLint / Prettier rules
- CI checks (recommended)

---
