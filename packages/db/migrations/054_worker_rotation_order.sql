-- Worker credential rotations are ordered (ADR 0206). Each rotation a
-- worker asks for carries an id it chose, a UUIDv7, so later requests sort
-- after earlier ones. A request replaces the pending credential only when
-- its id is later than the pending one's: a request that was delayed on its
-- way can never replace the credential a later request issued, which the
-- worker may already hold.
ALTER TABLE work_workers ADD COLUMN pending_rotation text;
