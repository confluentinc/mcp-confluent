#!/bin/sh
# entrypoint.sh

# Add all the extra hosts to /etc/hosts
cat >> /etc/hosts << EOF
# AWS Dev Staging Prod


# AWS QAT


# Azure NIC


# Azure Staging


# Azure Prod 1

# Azure Prod 2

# Azure Dev


# Azure HDInsight Clusters

EOF

# Execute the original command
exec node dist/index.js "$@"