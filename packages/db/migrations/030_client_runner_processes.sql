-- A member runner says whether its sandbox provider runs background
-- processes (ADR 0174); the control plane offers them only when it does.
ALTER TABLE client_runners ADD COLUMN processes boolean NOT NULL DEFAULT false;
