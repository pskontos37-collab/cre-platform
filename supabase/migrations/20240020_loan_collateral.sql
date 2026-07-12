-- Loan collateral mapping.
-- A loan's covenants (DSCR, debt yield) are measured against the NOI of the assets
-- that secure it. For a single-asset loan that is just its own property, but for a
-- cross-collateralized loan the borrowing/holding entity may have no GL of its own
-- (e.g. the KM "Consolidated" entity 012 holds the MetLife loan, but the income is
-- in KM East 010 + KM West 011). collateral_property_ids lists the GL-bearing
-- properties whose combined NOI backs the loan. NULL = fall back to [property_id].
alter table loans
  add column if not exists collateral_property_ids uuid[];

comment on column loans.collateral_property_ids is
  'Properties whose combined GL NOI secures this loan (for DSCR / debt-yield). NULL => [property_id].';
