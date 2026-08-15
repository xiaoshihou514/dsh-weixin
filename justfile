dsh := env_var_or_default("DSH_BIN", "dsh")

# Link this checkout into the DSH Web profile.
install:
    {{dsh}} plugin --profile web add "{{justfile_directory()}}"
