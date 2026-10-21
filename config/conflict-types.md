# Conflict types

A conflict is always a pair of norms inside the same document that cannot both be applied to the same situation. Every conflict needs two quotes from the main text of clauses.

## claim_vs_mechanic
### Definition
A general claim or promise (for example "non-custodial", "you keep exclusive control", "withdraw at any time") is contradicted by a concrete mechanism described elsewhere in the document (for example pooled addresses, keys held by the company, company-initiated transfers, mandatory delays).
### Example
Clause A: "The Service is fully non-custodial and users retain exclusive control of their assets."
Clause B: "Deposited assets are transferred to wallets whose signing keys are held by the Company."
### Не считать конфликтом
- Marketing or TL;DR summaries that simplify the main text (quote the main clause, never the TL;DR).
- A claim that is limited to a specific product or module when the mechanic belongs to a different product.
- Mechanics that apply only to an optional, explicitly separate feature that the claim expressly excludes.

## claim_vs_exception
### Definition
A rule stated in absolute terms is cut down by an exception or carve-out in another clause so that the absolute wording becomes false or meaningless.
### Example
Clause A: "We never restrict withdrawals."
Clause B: "We may suspend withdrawals at our discretion."
### Не считать конфликтом
- Exceptions that are announced in the rule itself ("except as provided in Section 9").
- Standard legal carve-outs such as "to the extent permitted by law" or "except where liability cannot lawfully be excluded".
- A rule and an exception that apply to clearly different situations.

## circular
### Definition
Two or more clauses refer to each other (or to a definition that refers back) so that the obligation or the rights can never be determined.
### Example
Clause A: "Fees are as set out in the Fee Policy."
Clause B (Fee Policy): "Fees are as set out in the Terms of Service."
### Не считать конфликтом
- Ordinary cross-references that end in a concrete rule.
- Incorporation by reference of an external document that is simply not provided (that is insufficient_data, not circular).

## definition_drift
### Definition
The same defined term is used with different meanings in different clauses, or a term is defined one way and used in a way that does not fit its definition, and the difference changes the legal outcome.
### Example
Definition: "'User' means a person over 18." Later: "Users under 16 may use the Service with parental consent."
### Не считать конфликтом
- Stylistic variation between synonyms with no legal effect.
- Terms deliberately scoped ("for the purposes of this Section, ...").
