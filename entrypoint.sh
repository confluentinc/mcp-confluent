#!/bin/sh
# entrypoint.sh

# Add all the extra hosts to /etc/hosts
cat >> /etc/hosts << EOF
# AWS Dev Staging Prod
172.31.120.118 pkc-xz5jk.us-east-1.aws.confluent.cloud
172.31.120.118 pkc-gryw3.us-east-1.aws.confluent.cloud
172.31.120.118 b0-pkc-gryw3.us-east-1.aws.confluent.cloud
172.31.120.118 b0-pkc-xz5jk.us-east-1.aws.confluent.cloud
172.31.120.118 b0-pkc-y86go.us-east-1.aws.confluent.cloud
172.31.120.118 b1-pkc-gryw3.us-east-1.aws.confluent.cloud
172.31.120.118 b1-pkc-xz5jk.us-east-1.aws.confluent.cloud
172.31.120.118 b1-pkc-y86go.us-east-1.aws.confluent.cloud
172.31.120.118 b2-pkc-gryw3.us-east-1.aws.confluent.cloud
172.31.120.118 b2-pkc-xz5jk.us-east-1.aws.confluent.cloud
172.31.120.118 b2-pkc-y86go.us-east-1.aws.confluent.cloud
172.31.120.118 pkc-y86go.us-east-1.aws.confluent.cloud

# AWS QAT
10.50.28.168 pkc-wxojw.us-east-1.aws.confluent.cloud
10.50.28.168 b0-pkc-wxojw.us-east-1.aws.confluent.cloud
10.50.28.168 b1-pkc-wxojw.us-east-1.aws.confluent.cloud
10.50.28.168 b2-pkc-wxojw.us-east-1.aws.confluent.cloud

# Azure NIC
10.83.5.11 pkc-zrody.northeurope.azure.confluent.cloud
10.83.5.11 pkc-1xppv.northeurope.azure.confluent.cloud
10.83.5.11 b2-pkc-zrody.northeurope.azure.confluent.cloud
10.83.5.11 b2-pkc-1xppv.northeurope.azure.confluent.cloud
10.83.5.11 b1-pkc-zrody.northeurope.azure.confluent.cloud
10.83.5.11 b1-pkc-1xppv.northeurope.azure.confluent.cloud
10.83.5.11 b0-pkc-zrody.northeurope.azure.confluent.cloud
10.83.5.11 b0-pkc-1xppv.northeurope.azure.confluent.cloud

# Azure Staging
10.80.153.6 pkc-nw53kz.eastus.azure.confluent.cloud
10.80.153.6 b2-pkc-nw53kz.eastus.azure.confluent.cloud
10.80.153.6 b1-pkc-nw53kz.eastus.azure.confluent.cloud
10.80.153.6 b0-pkc-nw53kz.eastus.azure.confluent.cloud

# Azure Prod 1
10.80.153.6 pkc-j30y02.eastus.azure.confluent.cloud
10.80.153.6 b2-pkc-j30y02.eastus.azure.confluent.cloud
10.80.153.6 b1-pkc-j30y02.eastus.azure.confluent.cloud
10.80.153.6 b0-pkc-j30y02.eastus.azure.confluent.cloud

# Azure Prod 2
10.80.153.6 pkc-5wgvxn.eastus.azure.confluent.cloud
10.80.153.6 b2-pkc-5wgvxn.eastus.azure.confluent.cloud
10.80.153.6 b1-pkc-5wgvxn.eastus.azure.confluent.cloud
10.80.153.6 b0-pkc-5wgvxn.eastus.azure.confluent.cloud

# Azure Dev
10.70.149.13 lkc-q90kw2.eastus.azure.private.confluent.cloud
10.70.149.13 b0-lkc-q90kw2.eastus.azure.private.confluent.cloud
10.70.149.13 b1-lkc-q90kw2.eastus.azure.private.confluent.cloud
10.70.149.13 b2-lkc-q90kw2.eastus.azure.private.confluent.cloud
10.70.149.13 b3-lkc-q90kw2.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g000.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g001.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g002.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g003.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g004.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g005.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g006.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g007.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g008.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g009.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g010.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g011.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g012.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g013.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g014.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g015.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g016.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g017.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g018.eastus.azure.private.confluent.cloud
10.70.149.13 lkc-q90kw2-g019.eastus.azure.private.confluent.cloud

# Azure HDInsight Clusters
10.72.149.55 hn0-fcseas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.54 hn1-fcseas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.17 wn0-fcseas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.16 wn1-fcseas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.28 wn2-fcseas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.25 zk0-fcseas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.44 zk1-fcseas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.42 zk2-fcseas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.48 hn0-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.47 hn1-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.35 wn0-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.36 wn1-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.34 wn2-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.5 wn3-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.4 wn4-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.41 zk0-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.39 zk1-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.37 zk2-ajweas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.30 hn0-wzjeas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.31 hn1-wzjeas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.12 wn0-wzjeas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.10 wn1-wzjeas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.9 wn2-wzjeas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.21 zk0-wzjeas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.23 zk1-wzjeas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
10.72.149.22 zk3-wzjeas.0n4ldf3jcoxuhjfy5bqfunoyuc.bx.internal.cloudapp.net
EOF

# Execute the original command
exec node dist/index.js "$@"