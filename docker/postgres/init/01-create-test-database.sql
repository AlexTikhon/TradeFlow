-- Runs once, on first initialisation of the data volume.
-- Integration tests use their own database so they never touch development data.
CREATE DATABASE tradeflow_test OWNER tradeflow;
