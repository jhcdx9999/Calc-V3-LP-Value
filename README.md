# Uniswap V3 LP Value Calculator

This tool calculates the value of Uniswap V3 LP positions, supporting queries for both current and historical blocks. Implemented in both Python and TypeScript.

## Features

- Calculate total LP position value
- Calculate unclaimed fees
- Support historical block queries
- Support custom price ranges
- Unified parameter management via config file
- Support proxy configuration
- Multiple token price sources

## Prerequisites

### Python Version
- Python 3.7+
- web3
- decimal
- requests

### TypeScript Version
- Node.js 14+
- ethers v6
- decimal.js

## Configuration

Edit "config.json" to set your parameters:

- "proxy": HTTP and HTTPS proxy settings
- "network": RPC URL and API key
- "contracts": Position manager and pool addresses
- "position": Position ID, price lower bound, and upper bound
- "query": Block number for historical queries
