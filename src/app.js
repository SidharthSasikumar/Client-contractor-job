const express = require('express');
const bodyParser = require('body-parser');
const {sequelize} = require('./model')
const Sequelize = require('sequelize');
const {getProfile} = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

/**
 * FIX ME!
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models');
    const { id } = req.params;
    const { profile } = req;

    console.log(`Request received for contract ID: ${id}`);
    console.log(`Authenticated profile: ${JSON.stringify(profile)}`);

    // Find the contract by ID
    const contract = await Contract.findOne({ where: { id } });

    if (!contract) {
        console.log(`Contract with ID ${id} not found.`);
        return res.status(404).end();  // Contract not found
    }

    console.log(`Contract found: ${JSON.stringify(contract)}`);

    // Check if the authenticated profile is the client or contractor of the contract
    if (contract.ClientId !== profile.id && contract.ContractorId !== profile.id) {
        console.log(`Profile ID ${profile.id} is not authorized to access this contract.`);
        return res.status(403).end();  // Forbidden
    }

    console.log(`Profile ID ${profile.id} is authorized to access this contract.`);

    // Return the contract if the profile is authorized
    res.json(contract);
});
// Fetch all non-terminated contracts belonging to the authenticated user
app.get('/contracts', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models');
    const { profile } = req;

    console.log(`Fetching contracts for profile ID: ${profile.id}`);

    try {
        // Find all contracts where the profile is either the client or contractor
        const contracts = await Contract.findAll({
            where: {
                [Sequelize.Op.or]: [
                    { ClientId: profile.id },
                    { ContractorId: profile.id }
                ],
                status: {
                    [Sequelize.Op.not]: 'terminated' // Exclude terminated contracts
                }
            }
        });

        console.log(`Contracts found: ${contracts.map(contract => contract.id).join(', ')}`);

        // Return the list of contracts
        res.json(contracts);
    } catch (error) {
        console.error('Error fetching contracts:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Fetch all unpaid jobs for a user (client or contractor) where contracts are active
app.get('/jobs/unpaid', getProfile, async (req, res) => {
    const { Job, Contract } = req.app.get('models');
    const { profile } = req;

    console.log(`Fetching unpaid jobs for profile ID: ${profile.id}`);

    try {
        // Find all unpaid jobs where the profile is either the client or contractor and the contract is active
        const unpaidJobs = await Job.findAll({
            include: [{
                model: Contract,
                where: {
                    [Sequelize.Op.or]: [
                        { ClientId: profile.id },
                        { ContractorId: profile.id }
                    ],
                    status: 'in_progress' // Only consider active contracts
                }
            }],
            where: {
                paid: false // Only unpaid jobs
            }
        });

        console.log(`Unpaid jobs found: ${unpaidJobs.map(job => job.id).join(', ')}`);

        // Return the list of unpaid jobs
        res.json(unpaidJobs);
    } catch (error) {
        console.error('Error fetching unpaid jobs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    const { Job, Contract, Profile } = req.app.get('models');
    const { job_id } = req.params;
    const { profile } = req;

    console.log(`Processing payment for job ID: ${job_id} by profile ID: ${profile.id}`);

    try {
        // Find the job and include the associated contract
        const job = await Job.findOne({
            where: { id: job_id },
            include: [{
                model: Contract,
                where: {
                    ClientId: profile.id, // Ensure the profile is the client
                }
            }]
        });

        if (!job) {
            console.log(`Job with ID ${job_id} not found or profile is not the client.`);
            return res.status(404).json({ error: 'Job not found or not authorized to pay for this job.' });
        }

        if (job.paid) {
            console.log(`Job with ID ${job_id} has already been paid.`);
            return res.status(400).json({ error: 'Job has already been paid.' });
        }

        // Check if the client has enough balance to pay for the job
        if (profile.balance < job.price) {
            console.log(`Client's balance (${profile.balance}) is less than job price (${job.price}).`);
            return res.status(400).json({ error: 'Insufficient balance to pay for the job.' });
        }

        // Start a transaction to ensure atomicity
        const transaction = await sequelize.transaction();

        try {
            // Deduct the job price from the client's balance
            profile.balance -= job.price;
            await profile.save({ transaction });

            // Find the contractor profile and add the job price to their balance
            const contractor = await Profile.findOne({ where: { id: job.Contract.ContractorId } });
            contractor.balance += job.price;
            await contractor.save({ transaction });

            // Mark the job as paid
            job.paid = true;
            job.paymentDate = new Date();
            await job.save({ transaction });

            // Commit the transaction
            await transaction.commit();

            console.log(`Payment processed successfully for job ID: ${job_id}.`);
            res.json({ message: 'Payment successful.' });
        } catch (error) {
            // Rollback the transaction in case of an error
            await transaction.rollback();
            console.error('Error processing payment:', error);
            res.status(500).json({ error: 'Failed to process payment.' });
        }
    } catch (error) {
        console.error('Error finding job or processing payment:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const { Profile, Job, Contract } = req.app.get('models');
    const { userId } = req.params;
    const { amount } = req.body; // Amount to deposit

    try {
        // Ensure the authenticated user is the same as the userId in the request
        if (req.profile.id !== parseInt(userId, 10)) {
            return res.status(403).json({ error: 'You can only deposit into your own account.' });
        }

        // Ensure the user is a client
        if (req.profile.type !== 'client') {
            return res.status(400).json({ error: 'Only clients can deposit money.' });
        }

        // Calculate the total amount of unpaid jobs for this client
        const unpaidJobs = await Job.findAll({
            include: [{
                model: Contract,
                where: {
                    ClientId: req.profile.id,
                    status: 'in_progress' // Only consider active contracts
                }
            }],
            where: {
                paid: false // Only unpaid jobs
            }
        });

        const totalUnpaidAmount = unpaidJobs.reduce((sum, job) => sum + job.price, 0);
        const maxDepositAmount = totalUnpaidAmount * 0.25;

        console.log(`Total unpaid amount: ${totalUnpaidAmount}`);
        console.log(`Maximum allowed deposit: ${maxDepositAmount}`);

        // Check if the deposit amount exceeds 25% of the total unpaid jobs amount
        if (amount > maxDepositAmount) {
            return res.status(400).json({ error: `Deposit amount exceeds the allowed limit of ${maxDepositAmount}.` });
        }

        // Update the client's balance
        req.profile.balance += amount;
        await req.profile.save();

        console.log(`Deposit successful. New balance: ${req.profile.balance}`);
        res.json({ message: 'Deposit successful.', newBalance: req.profile.balance });
    } catch (error) {
        console.error('Error processing deposit:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/admin/best-profession', async (req, res) => {
    const { start, end } = req.query;
    const { Profile } = req.app.get('models');
    try {
        // Validate date inputs
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end dates are required.' });
        }

        // Convert start and end dates to the appropriate format
        const startDate = new Date(start);
        const endDate = new Date(end);

        // Execute raw SQL query using sequelize.query
        const bestProfession = await sequelize.query(
            `SELECT Profile.profession, SUM(Jobs.price) AS totalEarnings
             FROM Profiles AS Profile
             INNER JOIN Contracts AS Contractor ON Contractor.ContractorId = Profile.id
             INNER JOIN Jobs ON Jobs.ContractId = Contractor.id
             WHERE Jobs.paid = 1 AND Jobs.paymentDate BETWEEN :startDate AND :endDate
             GROUP BY Profile.profession
             ORDER BY totalEarnings DESC
             LIMIT 1`,
            {
                replacements: { startDate, endDate },
                type: Sequelize.QueryTypes.SELECT,
                model: Profile,
                mapToModel: true // Map the results to the Profile model
            }
        );

        if (!bestProfession || bestProfession.length === 0) {
            return res.status(404).json({ error: 'No profession found for the given date range.' });
        }

        res.json(bestProfession[0]);
    } catch (error) {
        console.error('Error fetching best profession:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/admin/best-clients', async (req, res) => {
    const { start, end, limit = 2 } = req.query;

    try {
        // Validate date inputs
        if (!start || !end) {
            return res.status(400).json({ error: 'Start and end dates are required.' });
        }

        // Convert start and end dates to the appropriate format
        const startDate = new Date(start);
        const endDate = new Date(end);

        // Execute raw SQL query using sequelize.query
        const bestClients = await sequelize.query(
            `SELECT Profile.id, 
                    Profile.firstName || ' ' || Profile.lastName AS fullName, 
                    SUM(Jobs.price) AS paid
             FROM Profiles AS Profile
             INNER JOIN Contracts AS Contract ON Contract.ClientId = Profile.id
             INNER JOIN Jobs ON Jobs.ContractId = Contract.id
             WHERE Jobs.paid = 1 AND Jobs.paymentDate BETWEEN :startDate AND :endDate
             GROUP BY Profile.id
             ORDER BY paid DESC
             LIMIT :limit`,
            {
                replacements: { startDate, endDate, limit: parseInt(limit, 10) },
                type: Sequelize.QueryTypes.SELECT
            }
        );

        res.json(bestClients);
    } catch (error) {
        console.error('Error fetching best clients:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


module.exports = app;
